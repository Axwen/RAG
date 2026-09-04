#!/usr/bin/env bash
# npm 依赖漏洞门禁：读 pnpm-lock.yaml，问 OSV.dev，critical 阻断 / 其余只报告。
#
# 数据源与判定口径都没变过：npm 生态的条目在 OSV 里同样来自 GitHub Advisory DB（每条的
# `database_specific.source` 指回 github/advisory-database），severity 也还是 GHSA 那四档
# LOW/MODERATE/HIGH/CRITICAL。变的只是"问谁"。
#
# 为什么从 npm 的两个端点撤出来（三次 CI 全红换来的实测，详见 ci-cd.md §6.8-§6.10）：
# 1. `pnpm audit` 打 `/-/npm/v1/security/audits/quick`，npm 自己在响应里写着这个端点正在退役；
#    它的耗时横跨 pnpm 那个改不动的 60 秒超时，于是门禁变成抛硬币。
# 2. 换成官方推荐的 `/-/npm/v1/security/advisories/bulk` 也没用：200 个包一片要 45s 以上，
#    64 个包一片实测「最快 0.4s / 中位 39.4s / 最慢 74.0s」，同样的载荷有时 0.4 秒回、有时
#    过了 120 秒还不回，四路并发时开头四个请求一起挂住。慢的不是那个退役端点，是 npm 的
#    通告服务本身，而它慢得没有规律——超时、分片、并发三个旋钮怎么调都是赌。
# 3. 这条路还断了反馈回路：本机到这两个端点的 POST 一律卡死（1 个包也一样），每次调参都得
#    花一轮 7 分钟的 runner 才知道结果。
#
# OSV.dev 把这三条同时解决（2026-09-04 本机实测）：
#   - 548 个 name@version 一次 POST /v1/querybatch，1.58s 回全；掺 3 个已知有洞的包重测，
#     551 条查询 1.63s，恰好命中那 3 个——这既是延迟数，也是"0 命中不是解析失败"的证明。
#   - 服务端做版本区间匹配（minimist@1.2.0 命中 2 条、1.2.8 命中 0 条），所以照旧不需要本地
#     semver；命中包再逐版本问一次 /v1/query 拿全量字段，严重度直接在 database_specific 里。
#   - 无需鉴权、无 API key，所以 CI 不读任何 secret；本机能直连，调参不再靠 runner。
#
# 不装依赖、不需要 node：只读 lockfile + HTTPS POST，python3 标准库就够。
# 也刻意不进 `pnpm run verify`：verify 整条现在是离线的，掺一个网络调用进去会让本地门禁变抖。
# 进 verify 的是 --self-test（桩服务器，21 条断言，不碰网络）。
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

python3 - "$@" <<'PY'
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

BATCH_PATH = '/v1/querybatch'
QUERY_PATH = '/v1/query'
ECOSYSTEM = 'npm'
ORDER = ['low', 'moderate', 'high', 'critical']
RETRYABLE = {408, 425, 429, 500, 502, 503, 504}
OK, BLOCKED, NO_DATA, USAGE = 0, 1, 2, 3
IN_CI = os.environ.get('GITHUB_ACTIONS') == 'true'
KEY = re.compile(r"^  (?:'([^']+)'|([^\s:'][^:]*)):\s*$")
# main 里按 --budget-seconds 设定；每次请求前都看它，宁可自己超预算退出也不被 runner 掐掉。
DEADLINE = None
# 每次成功请求的耗时。跑完打一行分布，下一次调超时/预算不用再猜。
TIMINGS = []


class NoData(Exception):
    """取不到通告数据。单独一个异常类型，好让 main 统一转成 fail closed 的退出码。"""


class BadShape(Exception):
    """拿到了响应但结构不对。绝不在半份答案上判定，一律响。"""


def remaining():
    """离总预算耗尽还剩几秒；None 表示没设预算（自检打的是本地桩服务器）。"""
    return None if DEADLINE is None else DEADLINE - time.monotonic()


def die(code, msg):
    if IN_CI:
        print('::error::' + msg.lstrip('❌ '))
    print(msg, file=sys.stderr)
    raise SystemExit(code)


def parse_args(argv):
    opts = {'audit-level': 'critical', 'lockfile': 'pnpm-lock.yaml',
            'api': 'https://api.osv.dev', 'rounds': '3',
            'request-timeout': '30', 'budget-seconds': '120'}
    usage = ('可用参数：--audit-level --lockfile --api --rounds '
             '--request-timeout --budget-seconds')
    it = iter(argv)
    for arg in it:
        if not arg.startswith('--'):
            die(USAGE, f'❌ 无法识别的参数：{arg}。{usage}')
        key, sep, val = arg[2:].partition('=')
        if not sep:
            val = next(it, '')
        if key not in opts or val == '':
            die(USAGE, f'❌ 无法识别的参数：{arg}。{usage}')
        opts[key] = val
    if opts['audit-level'] not in ORDER:
        die(USAGE, f"❌ --audit-level 只能是 {'|'.join(ORDER)}")
    if not opts['rounds'].isdigit() or int(opts['rounds']) < 1:
        die(USAGE, '❌ --rounds 必须是正整数')
    for key in ('request-timeout', 'budget-seconds'):
        try:
            seconds = float(opts[key])
        except ValueError:
            seconds = 0.0
        if seconds <= 0:
            die(USAGE, f'❌ --{key} 必须是正数（秒）')
    return opts


def read_lockfile(path):
    """把 packages: 段切成 {包名: [版本]}。任何解析异常都抛，绝不返回半张依赖图。"""
    try:
        with open(path, encoding='utf-8') as handle:
            raw = handle.read()
    except OSError as exc:
        die(USAGE, f'❌ 读不到 lockfile：{exc}')
    head = re.search(r"^lockfileVersion: '(\d+)\.", raw, re.M)
    if head is None:
        die(USAGE, '❌ lockfile 开头没有 lockfileVersion：解析口径无法确认，'
                   '拒绝在不确定的输入上给出「无漏洞」')
    if head.group(1) != '9':
        die(USAGE, f'❌ lockfileVersion {head.group(1)}.x 与本脚本的解析口径（9.x）不符：'
                   '先确认 packages: 段的键仍是 name@version，再放宽这条断言')
    keys, resolutions, inside = [], 0, False
    for line in raw.splitlines():
        if not inside:
            inside = line == 'packages:'
            continue
        if line and not line[0].isspace():
            break
        matched = KEY.match(line)
        if matched:
            keys.append(matched.group(1) or matched.group(2))
        elif line.startswith('    resolution:'):
            resolutions += 1
    if not keys:
        die(USAGE, '❌ packages: 段解析出 0 个包：这不是「没有依赖」，是解析失败')
    if len(keys) != resolutions:
        die(USAGE, f'❌ packages: 段 {len(keys)} 个键对 {resolutions} 行 resolution:，'
                   '结构与预期不符，拒绝在半张依赖图上判定')
    wanted = {}
    for key in keys:
        name, _, version = key.rpartition('@')
        if not name or not re.match(r'^\d', version):
            die(USAGE, f'❌ 无法从 packages: 键切出 name@version：{key}')
        wanted.setdefault(name, set()).add(version)
    return {name: sorted(versions) for name, versions in wanted.items()}


def post(url, payload, opts, what):
    """POST 一个 JSON 回一个 JSON。重试只针对「这次不行下次可能行」的错，其余立即抛。

    三个时间量各管一件事，不要合并：
    - --request-timeout：单次请求的读超时，超了算一次失败，可重试。
    - --rounds：同一个请求最多试几次，指数退避。
    - --budget-seconds（DEADLINE）：整条门禁的总墙钟。每次请求前后都检查，
      预算耗尽就以 NO_DATA 退出——由脚本自己说「取不到数据」，比被 runner 的
      timeout-minutes 掐掉有用得多：那种死法不留日志、也分不清是网络还是死循环。
    """
    body = json.dumps(payload).encode()
    request = urllib.request.Request(
        url, data=body, method='POST',
        headers={'Content-Type': 'application/json',
                 'Accept': 'application/json',
                 'User-Agent': 'rag-ci-advisory-gate/2 (+scripts/check-npm-advisories.sh)'})
    last = '未知错误'
    rounds = int(opts['rounds'])
    per_request = float(opts['request-timeout'])
    for attempt in range(1, rounds + 1):
        left = remaining()
        if left is not None and left <= 0:
            raise NoData(f'{what}：总预算 {opts["budget-seconds"]}s 耗尽，'
                         f'已成功 {len(TIMINGS)} 次请求')
        timeout = per_request if left is None else min(per_request, left)
        started = time.monotonic()
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload_text = response.read().decode('utf-8', 'replace')
            TIMINGS.append(time.monotonic() - started)
            try:
                return json.loads(payload_text)
            except json.JSONDecodeError as exc:
                # 不重试：能连上、回了 200、但不是 JSON，再试一次也是同样的东西。
                raise BadShape(f'{what} 的响应不是 JSON：{exc}') from exc
        except urllib.error.HTTPError as exc:
            last = f'HTTP {exc.code}'
            if exc.code not in RETRYABLE:
                raise NoData(f'{what} 返回 {last}，不可重试') from exc
        except urllib.error.URLError as exc:
            last = f'{type(exc.reason).__name__}: {exc.reason}'
        except TimeoutError:
            last = f'读超时（{timeout:.0f}s）'
        if attempt < rounds:
            back = min(2.0 * attempt, 8.0)
            left = remaining()
            if left is not None and left - back <= 0:
                raise NoData(f'{what}：总预算 {opts["budget-seconds"]}s 剩不下重试所需的 '
                             f'{back:.0f}s（最后一次：{last}），已成功 {len(TIMINGS)} 次请求')
            time.sleep(back)
    raise NoData(f'{what} 连续 {rounds} 次失败（最后一次：{last}）')


def severity_of(vuln):
    """严重度取 GHSA 那一档。取不到就当 critical——宁可误阻断，不可漏放行。

    OSV 一条 vuln 有两处严重度：`database_specific.severity` 是 GHSA 的四档文字，
    `severity[]` 是 CVSS 向量。门禁的分档口径是四档，所以只认前者；缺了不去反推
    CVSS 分数，因为那需要在这里实现一套 CVSS 解析，错了没人发现。
    """
    specific = vuln.get('database_specific')
    value = ''
    if isinstance(specific, dict):
        value = str(specific.get('severity', '')).lower()
    return value if value in ORDER else 'critical'


def affected_range(vuln, name):
    """把命中包的受影响区间拼成一句人能读的话，拼不出就说「见通告」，不猜。"""
    spans = []
    for affected in vuln.get('affected', []) or []:
        package = affected.get('package') or {}
        if package.get('name') != name:
            continue
        for entry in affected.get('ranges', []) or []:
            introduced, fixed = None, None
            for event in entry.get('events', []) or []:
                introduced = event.get('introduced', introduced)
                fixed = event.get('fixed', fixed)
            if introduced is not None:
                spans.append(f'>={introduced}' + (f' <{fixed}' if fixed else ''))
    return ', '.join(dict.fromkeys(spans)) or '见通告'


def sweep(api, wanted, opts):
    """一次 querybatch 扫全图，返回 [(包名, 版本)]——只要「哪些包有洞」，不要细节。

    这里刻意不分片：548 个查询一次 1.6s 实测（ci-cd.md §6.10）。分片是上一版为了
    绕开 npm 的不稳定加的，代价是并发、合并顺序、分片大小三个旋钮，全部删掉。
    唯一的结构断言是 results 条数必须等于 queries 条数：OSV 的返回按查询顺序一一
    对应，条数不等就意味着对应关系已经错位，此时任何「没命中」都不可信。
    """
    pairs = [(name, version) for name in sorted(wanted) for version in wanted[name]]
    queries = [{'package': {'ecosystem': ECOSYSTEM, 'name': name}, 'version': version}
               for name, version in pairs]
    answer = post(api + BATCH_PATH, {'queries': queries}, opts,
                  f'批量查询 {len(queries)} 个 name@version')
    if not isinstance(answer, dict) or not isinstance(answer.get('results'), list):
        raise BadShape('批量查询的响应里没有 results 数组')
    results = answer['results']
    if len(results) != len(queries):
        raise BadShape(f'批量查询回了 {len(results)} 条结果对 {len(queries)} 条查询：'
                       '与查询顺序的一一对应已经错位，拒绝在错位的结果上判定')
    hits = []
    for (name, version), result in zip(pairs, results):
        if not isinstance(result, dict):
            raise BadShape(f'{name}@{version} 的结果不是对象')
        if result.get('next_page_token'):
            # 分页意味着这一条的漏洞列表被截断了。门禁只需要「有没有」，截断不影响
            # 这个判断，但它说明我们对这个 API 的理解有缺口，所以响一声而不是默默继续。
            raise BadShape(f'{name}@{version} 的结果带 next_page_token：'
                           '本脚本没实现分页，拒绝在可能被截断的结果上判定')
        if result.get('vulns'):
            hits.append((name, version))
    return hits


def details(api, hits, opts):
    """对命中的 (包, 版本) 逐个问 /v1/query 拿全量字段，聚成打印用的行。

    为什么不复用 querybatch 的结果：它每条只回 {id, modified}，没有 severity 也没有
    区间。命中数正常是 0，有洞时也是个位数，逐个问比拉全库便宜且不用本地缓存。
    """
    rows = {}
    for name, version in hits:
        answer = post(api + QUERY_PATH,
                      {'package': {'ecosystem': ECOSYSTEM, 'name': name}, 'version': version},
                      opts, f'查询 {name}@{version} 的通告详情')
        if not isinstance(answer, dict):
            raise BadShape(f'{name}@{version} 的详情响应不是对象')
        if answer.get('next_page_token'):
            raise BadShape(f'{name}@{version} 的详情带 next_page_token：'
                           '本脚本没实现分页，拒绝在可能被截断的结果上判定')
        vulns = answer.get('vulns')
        if not isinstance(vulns, list) or not vulns:
            # 扫描说有、详情说没有：两个端点自相矛盾，不能当「没漏洞」。
            raise BadShape(f'{name}@{version} 在批量查询里命中、详情里为空：'
                           '两个端点结果矛盾，拒绝判定')
        for vuln in vulns:
            if not isinstance(vuln, dict) or not vuln.get('id'):
                raise BadShape(f'{name}@{version} 的通告缺 id')
            # 按 (包, 通告) 去重：同一个通告会被多个版本命中，只打印一次并合并版本号。
            slot = rows.setdefault((name, vuln['id']), {
                'name': name, 'id': vuln['id'], 'versions': set(),
                'severity': severity_of(vuln),
                'withdrawn': bool(vuln.get('withdrawn')),
                'title': (str(vuln.get('summary') or '（无标题）').strip().splitlines() or ['（无标题）'])[0],
                'range': affected_range(vuln, name),
            })
            slot['versions'].add(version)
    return sorted(rows.values(), key=lambda row: (-ORDER.index(row['severity']),
                                                  row['name'], row['id']))


def render(rows):
    for row in rows:
        mark = '（已撤回）' if row['withdrawn'] else ''
        print(f"  {row['severity']:<8} {row['name']}@{','.join(sorted(row['versions']))}"
              f"{mark}  受影响区间 {row['range']}")
        print(f"           {row['id']}  {row['title']}")
        print(f"           https://osv.dev/vulnerability/{row['id']}")


def report_timings(opts, wall):
    """把实测耗时打出来。上一版全靠这一行才知道「慢的没有规律」，留着。"""
    if not TIMINGS:
        print(f'（没有成功的请求；墙钟 {wall:.1f}s）')
        return
    ordered = sorted(TIMINGS)
    middle = ordered[len(ordered) // 2]
    print(f'OSV 请求 {len(ordered)} 次成功：最快 {ordered[0]:.1f}s / '
          f'中位 {middle:.1f}s / 最慢 {ordered[-1]:.1f}s，墙钟 {wall:.1f}s'
          f'（单次上限 {opts["request-timeout"]}s、总预算 {opts["budget-seconds"]}s）')


def main(argv):
    global DEADLINE
    if argv[:1] == ['--self-test']:
        return self_test(argv[1:])
    opts = parse_args(argv)
    wanted = read_lockfile(opts['lockfile'])
    total = sum(len(versions) for versions in wanted.values())
    api = opts['api'].rstrip('/')
    print(f'扫描 {len(wanted)} 个包 / {total} 个 name@version（{opts["lockfile"]}）'
          f'，数据源 {api}')
    started = time.monotonic()
    DEADLINE = started + float(opts['budget-seconds'])
    try:
        rows = details(api, sweep(api, wanted, opts), opts)
    except NoData as exc:
        die(NO_DATA, f'❌ {exc}：这不是「没有漏洞」，是取不到数据')
    except BadShape as exc:
        die(USAGE, f'❌ {exc}')
    wall = time.monotonic() - started
    threshold = ORDER.index(opts['audit-level'])
    # 已撤回的通告一律只报告：它被上游撤回就意味着判定依据已经不成立，用它阻断
    # 是拿一条作废的事实卡住所有人。但也不静默丢掉——撤回本身值得看见一眼。
    blocking = [row for row in rows
                if not row['withdrawn'] and ORDER.index(row['severity']) >= threshold]
    blocked_keys = {(row['name'], row['id']) for row in blocking}
    reported = [row for row in rows if (row['name'], row['id']) not in blocked_keys]
    if reported:
        print(f'⚠️  低于 {opts["audit-level"]} 或已撤回，只报告不阻断（{len(reported)} 条）：')
        render(reported)
        if IN_CI:
            print(f'::warning::{len(reported)} 条依赖漏洞低于阻断阈值 '
                  f'{opts["audit-level"]}（或已撤回），详见日志')
    report_timings(opts, wall)
    if blocking:
        print(f'❌ {opts["audit-level"]} 及以上漏洞 {len(blocking)} 条，阻断：')
        render(blocking)
        if IN_CI:
            print(f'::error::{len(blocking)} 条 {opts["audit-level"]} 及以上依赖漏洞，'
                  '必须先升级依赖或记录例外')
        return BLOCKED
    print(f'✅ 无 {opts["audit-level"]} 及以上依赖漏洞')
    return OK


# ─── 离线自检 ────────────────────────────────────────────────────────────
# 这个门禁最坏的失效方式不是红，是解析出 0 个包然后报「没有漏洞」。所以每一条
# fail closed 的路径都要有断言，且断言本身要被验证过：改坏任一条判定，必须有断言变红。
# 桩服务器完全离线（127.0.0.1 随机端口），所以它能进 `pnpm run verify`。

FIXTURE = {
    'vulny': [
        {'id': 'GHSA-crit-0001', 'summary': '任意代码执行', 'sev': 'CRITICAL',
         'introduced': '0', 'fixed': '2.0.0', 'hit': {'1.0.0', '1.5.0'}},
        {'id': 'GHSA-mod-0002', 'summary': '原型污染', 'sev': 'MODERATE',
         'introduced': '0', 'fixed': '3.0.0', 'hit': {'1.0.0', '1.5.0'}},
    ],
    'mildly': [
        {'id': 'GHSA-mod-0006', 'summary': '只到 moderate，不该阻断', 'sev': 'MODERATE',
         'introduced': '0', 'fixed': '4.0.0', 'hit': {'1.0.0'}},
    ],
    'weird': [
        {'id': 'GHSA-weird-0003', 'summary': '严重度写了个没见过的词', 'sev': 'APOCALYPTIC',
         'introduced': '0', 'fixed': '9.9.9', 'hit': {'1.0.0'}},
    ],
    'nosev': [
        {'id': 'GHSA-nosev-0004', 'summary': '整个 database_specific 都没有', 'sev': None,
         'introduced': '0', 'fixed': '9.9.9', 'hit': {'1.0.0'}},
    ],
    'gone': [
        {'id': 'GHSA-gone-0005', 'summary': '误报，已被上游撤回', 'sev': 'CRITICAL',
         'introduced': '0', 'fixed': '2.0.0', 'hit': {'1.0.0'},
         'withdrawn': '2026-01-01T00:00:00Z'},
    ],
}


def _vuln_json(name, entry, full):
    """full=False 模拟 querybatch 的精简形状（只有 id/modified），True 模拟 query 的全量形状。"""
    if not full:
        return {'id': entry['id'], 'modified': '2026-01-01T00:00:00Z'}
    out = {
        'id': entry['id'],
        'summary': entry['summary'],
        'modified': '2026-01-01T00:00:00Z',
        'affected': [{'package': {'ecosystem': ECOSYSTEM, 'name': name},
                      'ranges': [{'type': 'SEMVER',
                                  'events': [{'introduced': entry['introduced']},
                                             {'fixed': entry['fixed']}]}]}],
    }
    if entry['sev'] is not None:
        out['database_specific'] = {'severity': entry['sev']}
    if entry.get('withdrawn'):
        out['withdrawn'] = entry['withdrawn']
    return out


def _hits_for(name, version, full):
    return [_vuln_json(name, entry, full)
            for entry in FIXTURE.get(name, []) if version in entry['hit']]


def self_test(extra):
    if extra:
        die(USAGE, f'❌ --self-test 不接受其它参数：{" ".join(extra)}')
    import contextlib
    import io
    import tempfile
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    state = {'mode': 'ok', 'sleep': 5}

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, *args):
            pass

        def _send(self, code, payload):
            body = json.dumps(payload).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            mode = state['mode']
            if mode == 'slow':
                time.sleep(state['sleep'])
            if mode == 'boom':
                self._send(503, {'error': 'stub 故意 503'})
                return
            if mode == 'garbage':
                body = b'<html>not json</html>'
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            length = int(self.headers.get('Content-Length') or 0)
            sent = json.loads(self.rfile.read(length).decode() or '{}')
            if self.path == BATCH_PATH:
                results = []
                for query in sent.get('queries', []):
                    name = query['package']['name']
                    found = _hits_for(name, query['version'], full=False)
                    results.append({'vulns': found} if found else {})
                if mode == 'shortbatch' and results:
                    results.pop()
                if mode == 'pagedbatch':
                    for result in results:
                        if result.get('vulns'):
                            result['next_page_token'] = 'stub-token'
                            break
                self._send(200, {'results': results})
                return
            if self.path == QUERY_PATH:
                if mode == 'emptydetail':
                    self._send(200, {})
                    return
                found = _hits_for(sent['package']['name'], sent['version'], full=True)
                answer = {'vulns': found} if found else {}
                if mode == 'pagedquery':
                    answer['next_page_token'] = 'stub-token'
                self._send(200, answer)
                return
            self._send(404, {'error': f'stub 不认识 {self.path}'})

    class Server(ThreadingHTTPServer):
        daemon_threads = True

        def handle_error(self, request, address):
            # 断言里刻意让客户端先超时再走掉，桩服务器写回时的 EPIPE 是预期的，不打栈。
            pass

    server = Server(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    api = f'http://127.0.0.1:{server.server_address[1]}'
    workdir = tempfile.mkdtemp(prefix='advisory-selftest-')
    counter = {'n': 0}
    failures = []

    def lockfile(label, body):
        path = os.path.join(workdir, f'{label}.yaml')
        with open(path, 'w', encoding='utf-8') as handle:
            handle.write(body)
        return path

    def good(pairs, version='9.0'):
        lines = [f"lockfileVersion: '{version}'", '', 'settings:',
                 '  autoInstallPeers: true', '', 'packages:', '']
        for name, ver in pairs:
            lines += [f'  {name}@{ver}:', '    resolution: {integrity: sha512-stub}', '']
        lines += ['snapshots:', '']
        return '\n'.join(lines)

    def run(label, argv, want_code, want_in=(), want_not_in=()):
        global DEADLINE
        counter['n'] += 1
        DEADLINE = None
        TIMINGS.clear()
        buffer = io.StringIO()
        try:
            with contextlib.redirect_stdout(buffer), contextlib.redirect_stderr(buffer):
                code = main(list(argv) + ['--api', api])
        except SystemExit as exc:
            code = exc.code
        out = buffer.getvalue()
        problems = []
        if code != want_code:
            problems.append(f'退出码 {code} != {want_code}')
        for needle in ([want_in] if isinstance(want_in, str) else want_in):
            if needle not in out:
                problems.append(f'输出里缺「{needle}」')
        for needle in ([want_not_in] if isinstance(want_not_in, str) else want_not_in):
            if needle in out:
                problems.append(f'输出里不该有「{needle}」')
        if problems:
            failures.append(f'#{counter["n"]} {label}：' + '；'.join(problems)
                            + '\n' + '\n'.join('    | ' + line for line in out.splitlines()))
        print(('  ok   ' if not problems else '  FAIL ') + f'#{counter["n"]} {label}')

    clean = lockfile('clean', good([('clean', '1.0.0')]))
    vulny = lockfile('vulny', good([('vulny', '1.0.0')]))
    two = lockfile('two-versions', good([('vulny', '1.0.0'), ('vulny', '1.5.0')]))
    mildly = lockfile('mildly', good([('mildly', '1.0.0')]))
    weird = lockfile('weird', good([('weird', '1.0.0')]))
    nosev = lockfile('nosev', good([('nosev', '1.0.0')]))
    gone = lockfile('gone', good([('gone', '1.0.0')]))

    print('判定口径：')
    state['mode'] = 'ok'
    run('critical 阻断，同包的 moderate 只报告', ['--lockfile', vulny], BLOCKED,
        ['GHSA-crit-0001', '阻断', 'GHSA-mod-0002', '只报告不阻断', 'OSV 请求'])
    run('只有 moderate 时放行', ['--lockfile', mildly], OK,
        ['GHSA-mod-0006', '只报告不阻断', '✅ 无 critical'])
    run('阈值降到 moderate，同一条就阻断',
        ['--lockfile', mildly, '--audit-level', 'moderate'], BLOCKED, ['GHSA-mod-0006', '阻断'])
    run('干净的依赖图放行', ['--lockfile', clean], OK, '✅ 无 critical', 'GHSA-')
    run('没见过的 severity 当 critical', ['--lockfile', weird], BLOCKED,
        ['GHSA-weird-0003', '阻断'])
    run('缺 database_specific 当 critical', ['--lockfile', nosev], BLOCKED,
        ['GHSA-nosev-0004', '阻断'])
    run('已撤回的 critical 只报告不阻断', ['--lockfile', gone], OK,
        ['GHSA-gone-0005', '（已撤回）', '✅ 无 critical'])
    run('同一通告命中多个版本时合并成一行', ['--lockfile', two], BLOCKED,
        'vulny@1.0.0,1.5.0')

    print('lockfile 解析（宁可报错，不可解析出 0 个包然后说没漏洞）：')
    run('lockfile 不存在', ['--lockfile', os.path.join(workdir, 'nope.yaml')], USAGE,
        '读不到 lockfile')
    run('开头没有 lockfileVersion',
        ['--lockfile', lockfile('nohead', 'packages:\n  vulny@1.0.0:\n'
                                '    resolution: {integrity: sha512-stub}\n')],
        USAGE, 'lockfileVersion')
    run('lockfileVersion 8.x 与解析口径不符',
        ['--lockfile', lockfile('v8', good([('vulny', '1.0.0')], version='8.0'))],
        USAGE, '8.x')
    run('packages: 段 0 个包',
        ['--lockfile', lockfile('empty', "lockfileVersion: '9.0'\n\npackages:\n\nsnapshots:\n")],
        USAGE, '0 个包')
    run('键数与 resolution 行数不等',
        ['--lockfile', lockfile('lopsided', "lockfileVersion: '9.0'\n\npackages:\n\n"
                                '  vulny@1.0.0:\n    resolution: {integrity: sha512-stub}\n\n'
                                '  vulny@1.5.0:\n\n')],
        USAGE, 'resolution')
    run('键里切不出 name@version',
        ['--lockfile', lockfile('badkey', good([('vulny', 'latest')]))],
        USAGE, '切出 name@version')

    print('参数校验：')
    run('无法识别的参数', ['--nope', '1'], USAGE, '无法识别的参数')
    run('--audit-level 非法', ['--lockfile', clean, '--audit-level', 'nope'], USAGE,
        '--audit-level 只能是')
    run('--rounds 非正整数', ['--lockfile', clean, '--rounds', '0'], USAGE, '--rounds')
    run('--request-timeout 非正数', ['--lockfile', clean, '--request-timeout', '0'], USAGE,
        '--request-timeout')
    run('--budget-seconds 不是数', ['--lockfile', clean, '--budget-seconds', 'soon'], USAGE,
        '--budget-seconds')

    print('取不到数据时 fail closed（绝不退化成「没有漏洞」）：')
    state['mode'] = 'boom'
    # rounds 1：503 这条只验「可重试的 HTTP 错最终也要 fail closed」，重试本身由 #23 验，
    # 在这里多试一轮只是让自检多等一个退避周期。
    run('服务端一直 503 → 取不到数据', ['--lockfile', vulny, '--rounds', '1',
                                 '--budget-seconds', '30'],
        NO_DATA, ['取不到数据', 'HTTP 503'], '✅')
    state['mode'] = 'garbage'
    run('响应不是 JSON → 响，不猜', ['--lockfile', vulny], USAGE, '不是 JSON', '✅')
    state['mode'] = 'slow'
    state['sleep'] = 5
    run('单次读超时且预算不够重试 → 取不到数据',
        ['--lockfile', vulny, '--request-timeout', '0.4', '--rounds', '3',
         '--budget-seconds', '1'],
        NO_DATA, ['取不到数据', '总预算', '读超时'], '✅')
    run('单次读超时、重试耗尽 → 取不到数据',
        ['--lockfile', vulny, '--request-timeout', '0.4', '--rounds', '2',
         '--budget-seconds', '30'],
        NO_DATA, ['取不到数据', '连续 2 次失败', '读超时'], '✅')

    print('响应结构不对时响一声（半份答案上不判定）：')
    state['mode'] = 'shortbatch'
    run('results 条数少于 queries → 错位', ['--lockfile', two], USAGE, '错位', '✅')
    state['mode'] = 'pagedbatch'
    run('批量结果带 next_page_token', ['--lockfile', vulny], USAGE, 'next_page_token', '✅')
    state['mode'] = 'emptydetail'
    run('批量命中但详情为空 → 两个端点矛盾', ['--lockfile', vulny], USAGE, '矛盾', '✅')
    state['mode'] = 'pagedquery'
    run('详情带 next_page_token', ['--lockfile', vulny], USAGE, 'next_page_token', '✅')

    server.shutdown()
    if failures:
        print('')
        for line in failures:
            print(line)
        die(BLOCKED, f'❌ 自检 {len(failures)}/{counter["n"]} 条断言失败')
    print(f'✅ 自检 {counter["n"]}/{counter["n"]} 条断言全通过（离线桩 registry）')
    return OK


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
PY
