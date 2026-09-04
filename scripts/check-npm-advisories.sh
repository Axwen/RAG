#!/usr/bin/env bash
# npm 依赖漏洞门禁：读 pnpm-lock.yaml，问 npm 的 bulk advisory 端点，critical 阻断 / 其余只报告。
#
# 为什么不是 `pnpm audit`：pnpm 10 打的是 `/-/npm/v1/security/audits/quick`，而 npm 自己在每次
# 响应里就写着「This endpoint is being retired. Use the bulk advisory endpoint instead.」。退役
# 中的接口对本仓库这张依赖图要 55 秒到 2 分钟才回，pnpm 的 fetch 超时是 60 秒，而 `pnpm audit`
# 既不接受 --fetch-timeout，也不吃 npm_config_fetch_timeout（2026-09-04 两处实测都不生效）。
# 于是它变成抛硬币：PR #28 抛中了（整步 15m3s，job 上限 20 分钟），PR #27 三轮全
# ERR_SOCKET_TIMEOUT 而红。加重试预算没有出路——天花板已经用掉了四分之三。
#
# 换的是接口，不是数据源：bulk 端点背后仍是 GitHub Advisory DB、仍是 npm 官方 registry，
# critical 阻断 / high 只报告的口径一个字没动。npm 自己的 CLI 也是先打 bulk、失败才回落 quick
# （@npmcli/arborist lib/audit-report.js 的 _getReport）。
#
# 为什么不做本地 semver 区间匹配：bulk 端点按「POST 进去的那些版本」过滤，返回的通告都命中了
# 我们送进去的某个版本。真要漏只会漏在服务端，这与 `pnpm audit` 承担的是同一个风险；而万一多
# 算一条，只会让门禁更严不会更松。同名多版本的包再逐版本追问一次，把「哪个版本中招」定准。
#
# 不装依赖、不需要 node：只读 lockfile + HTTPS POST，python3 标准库就够。
# 也刻意不进 `pnpm run verify`：verify 整条现在是离线的，掺一个网络调用进去会让本地门禁变抖。
#
# 2026-09-04 CI 首跑给出的实测（本机到这个端点的 POST 一律卡死，1 个包也一样，所以数只有 runner
# 上的这一份）：200 个包一片，第一片两次 60s 读超时、第三次约 45s 成功，第二片又一次 60s 超时，
# 整步撞上 5 分钟 job 上限。也就是说慢的不是「退役中的那个端点」，是 npm 的通告服务本身，
# 而 60s 恰好卡在它的响应时间上。由此定下四个数，改之前先看输出末尾那行耗时分布：
#   --request-timeout 120  单次读超时抬到实测最慢值的两倍以上，别再拿超时当「没有漏洞」的信号
#   --chunk 64             分片调小：若延迟随包数涨，这一刀直接把单次请求拉进十几秒
#   --workers 4            并发发片：若延迟是固定开销，靠并发把墙钟压住（429 走重试）
#   --budget-seconds 420   自己的总预算先到，才能带着 ::error:: 说明退出；被 runner 掐掉只留一句
#                          「The operation was canceled.」，下一次还是得靠猜
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

python3 - "$@" <<'PY'
import concurrent.futures
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

BULK_PATH = '/-/npm/v1/security/advisories/bulk'
ORDER = ['low', 'moderate', 'high', 'critical']
RETRYABLE = {408, 425, 429, 500, 502, 503, 504}
OK, BLOCKED, NO_DATA, USAGE = 0, 1, 2, 3
IN_CI = os.environ.get('GITHUB_ACTIONS') == 'true'
KEY = re.compile(r"^  (?:'([^']+)'|([^\s:'][^:]*)):\s*$")
# main 里按 --budget-seconds 设定；每次请求前都看它，宁可自己超预算退出也不被 runner 掐掉。
DEADLINE = None
# 每次成功请求的耗时。跑完打一行分布，下一次调 --chunk/--workers 不用再猜。
TIMINGS = []


class NoData(Exception):
    """取不到 advisory。不在工作线程里直接 die：SystemExit 会被 future 吞成一句无关的报错。"""


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
            'registry': 'https://registry.npmjs.org', 'rounds': '3',
            'chunk': '64', 'workers': '4', 'request-timeout': '120',
            'budget-seconds': '420'}
    usage = ('可用参数：--audit-level --lockfile --registry --rounds --chunk --workers '
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
    for key in ('rounds', 'chunk', 'workers'):
        if not opts[key].isdigit() or int(opts[key]) < 1:
            die(USAGE, f'❌ --{key} 必须是正整数')
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


def post_json(url, payload, rounds, timeout):
    """一次 bulk 查询。网络类错误重试；取不到数据一律抛 NoData，不降级成「没有漏洞」。

    单次读超时按剩余总预算收窄：预算只剩 20s 就没必要挂着等 120s——那样 runner 会先把整个
    job 掐掉，而被掐掉的 job 只留一句 `The operation was canceled.`，说不出是谁没回。
    """
    body = json.dumps(payload).encode()
    last = ''
    for attempt in range(1, rounds + 1):
        left = remaining()
        if left is not None and left <= 1:
            raise NoData(f'总预算耗尽，来不及再问一次（最后一次 {last or "请求还没发出"}）')
        request = urllib.request.Request(url, data=body, method='POST', headers={
            'content-type': 'application/json',
            'accept': 'application/json',
            'user-agent': 'rag-ci-advisory-check',
        })
        started = time.monotonic()
        try:
            with urllib.request.urlopen(request,
                                        timeout=timeout if left is None else min(timeout, left)) as response:
                data = json.loads(response.read().decode('utf-8'))
            TIMINGS.append(time.monotonic() - started)
            return data
        except urllib.error.HTTPError as exc:
            last = f'HTTP {exc.code}'
            if exc.code not in RETRYABLE:
                try:
                    detail = exc.read()[:300].decode('utf-8', 'replace')
                except OSError:
                    detail = '(读不到响应体)'
                raise NoData(f'bulk 端点返回 {exc.code}：{detail}') from exc
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
            last = f'{type(exc).__name__}: {exc}（等了 {time.monotonic() - started:.0f}s）'
        if attempt < rounds:
            wait = attempt * 10
            left = remaining()
            if left is not None and left <= wait:
                raise NoData(f'总预算只剩 {left:.0f}s，退避 {wait}s 再问一次也来不及'
                             f'（最后一次 {last}）')
            print(f'⚠️  第 {attempt} 次取 advisory 失败（{last}），{wait}s 后重试', flush=True)
            time.sleep(wait)
    raise NoData(f'bulk 端点 {rounds} 轮均取不到数据（最后一次 {last}）')


def severity_of(advisory):
    """未知严重度按最高档处理：门禁宁可多挡一条，也不因为一个没见过的枚举值放行。"""
    value = str(advisory.get('severity', '')).lower()
    return value if value in ORDER else 'critical'


def collect(url, wanted, opts):
    """问完所有分片，合成报告行。分片并发只压墙钟，不改判定口径。"""
    rounds, size = int(opts['rounds']), int(opts['chunk'])
    workers, timeout = int(opts['workers']), float(opts['request-timeout'])
    names = sorted(wanted)
    chunks = [{name: wanted[name] for name in names[start:start + size]}
              for start in range(0, len(names), size)]

    def ask(chunk):
        return post_json(url, chunk, rounds, timeout)

    if workers > 1 and len(chunks) > 1:
        # 线程够了：全程阻塞在 socket 上，没有 CPU 工作要抢 GIL。
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            answers = list(pool.map(ask, chunks))
    else:
        answers = [ask(chunk) for chunk in chunks]

    found = {}
    # 按分片顺序合并，不按线程完成顺序：同一份 lockfile 的输出必须逐字可复现。
    for answer in answers:
        for name, advisories in answer.items():
            found.setdefault(name, []).extend(advisories)
    rows = []
    for name in sorted(found):
        versions = wanted.get(name, [])
        pinned = {}
        if len(versions) > 1:
            # 同名多版本：逐版本再问一次，否则报告只能说「这个包中招」，说不出哪个版本。
            for version in versions:
                for advisory in post_json(url, {name: [version]}, rounds, timeout).get(name, []):
                    pinned.setdefault(advisory.get('id'), []).append(version)
        seen = set()
        for advisory in found[name]:
            ident = advisory.get('id')
            if ident in seen:
                continue
            seen.add(ident)
            rows.append({
                'severity': severity_of(advisory),
                'name': name,
                'versions': pinned.get(ident, versions),
                'range': advisory.get('vulnerable_versions', '?'),
                'title': advisory.get('title', '(无标题)'),
                'url': advisory.get('url', ''),
            })
    rows.sort(key=lambda row: (-ORDER.index(row['severity']), row['name']))
    return rows


def render(rows):
    for row in rows:
        print(f"   {row['severity']:<8} {row['name']}@{','.join(row['versions'])}"
              f"  受影响区间 {row['range']}\n"
              f"            {row['title']}  {row['url']}")


# ─── 自检（离线，不碰网络）────────────────────────────────────────────────
# 这个门禁最危险的失效方式不是红，是「解析出 0 个包然后说没有漏洞」。所以解析守卫、
# 严重度分档、阻断/只报告的切分、以及取不到数据时必须 fail closed，都要有可复跑的断言。
# 桩服务器照 bulk 端点的行为回：只返回命中「POST 进去的那些版本」的通告。

FIXTURE = {
    'vulny': [
        {'id': 1, 'severity': 'critical', 'vulnerable_versions': '<2.0.0',
         'title': '假的 critical', 'url': 'https://example.invalid/1', '_hits': ['1.0.0']},
        {'id': 2, 'severity': 'moderate', 'vulnerable_versions': '<3.0.0',
         'title': '假的 moderate', 'url': 'https://example.invalid/2', '_hits': ['1.0.0', '2.5.0']},
    ],
    'weird': [
        {'id': 3, 'severity': 'apocalyptic', 'vulnerable_versions': '*',
         'title': '没见过的严重度', 'url': 'https://example.invalid/3', '_hits': ['1.0.0']},
    ],
}


def self_test():
    import contextlib
    import http.server
    import io
    import tempfile
    import threading

    # 自检里断言的是「该阻断的阻断」，不是「这个仓库有漏洞」。留着 ::error:: 会让一条
    # 绿的 job 在 GitHub 上挂十几条假红注解，所以自检期间关掉注解输出。
    global IN_CI
    IN_CI = False
    state = {'mode': 'ok', 'sleep': 2}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get('content-length', '0'))
            payload = json.loads(self.rfile.read(length) or b'{}')
            if state['mode'] == 'slow':
                # 慢到客户端先超时：这正是 2026-09-04 CI 首跑撞上的那种失败。
                time.sleep(state['sleep'])
            if state['mode'] == 'boom':
                self.send_response(503)
                self.send_header('content-length', '4')
                self.end_headers()
                self.wfile.write(b'nope')
                return
            body = {}
            for name, versions in payload.items():
                hit = [adv for adv in FIXTURE.get(name, [])
                       if any(version in adv['_hits'] for version in versions)]
                if hit:
                    body[name] = [{k: v for k, v in adv.items() if k != '_hits'} for adv in hit]
            raw = json.dumps(body).encode()
            self.send_response(200)
            self.send_header('content-type', 'application/json')
            self.send_header('content-length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, *args):
            pass

    class Server(http.server.ThreadingHTTPServer):
        daemon_threads = True

        def handle_error(self, request, client_address):
            # 客户端超时后先关连接是这几条断言的一部分，断管 traceback 不该混进自检输出。
            pass

    server = Server(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    registry = f'http://127.0.0.1:{server.server_address[1]}'
    workdir = tempfile.mkdtemp(prefix='advisory-selftest-')
    failures = []

    def lockfile(name, version_line, entries):
        path = os.path.join(workdir, name)
        lines = [f'lockfileVersion: {version_line}', '', 'packages:', '']
        for entry in entries:
            lines.append(f'  {entry}:')
            lines.append('    resolution: {integrity: sha512-fake}')
        with open(path, 'w', encoding='utf-8') as handle:
            handle.write('\n'.join(lines) + '\n')
        return path

    def run(label, argv, want_code, want_in=(), want_not_in=()):
        buffer = io.StringIO()
        code = 0
        argv = list(argv) + ['--registry', registry]
        try:
            with contextlib.redirect_stdout(buffer), contextlib.redirect_stderr(buffer):
                code = main(argv)
        except SystemExit as exc:
            code = exc.code
        out = buffer.getvalue()
        problems = []
        if code != want_code:
            problems.append(f'exit 期望 {want_code} 实到 {code}')
        for needle in want_in:
            if needle not in out:
                problems.append(f'输出应包含「{needle}」')
        for needle in want_not_in:
            if needle in out:
                problems.append(f'输出不应包含「{needle}」')
        if problems:
            failures.append(f'{label}：' + '；'.join(problems))
            print(f'  ✗ {label}')
            for line in out.strip().splitlines():
                print(f'      {line}')
        else:
            print(f'  ✓ {label}')

    clean = lockfile('clean.yaml', "'9.0'", ['safe-a@1.0.0', 'safe-b@2.3.4'])
    critical = lockfile('critical.yaml', "'9.0'", ['vulny@1.0.0'])
    both = lockfile('both.yaml', "'9.0'", ['vulny@1.0.0', 'vulny@2.5.0'])
    moderate = lockfile('moderate.yaml', "'9.0'", ['vulny@2.5.0'])
    unknown = lockfile('unknown.yaml', "'9.0'", ['weird@1.0.0'])
    mixed = lockfile('mixed.yaml', "'9.0'", ['safe-a@1.0.0', 'vulny@1.0.0', 'weird@1.0.0'])
    future = lockfile('future.yaml', "'10.0'", ['safe-a@1.0.0'])
    headless = os.path.join(workdir, 'headless.yaml')
    with open(headless, 'w', encoding='utf-8') as handle:
        handle.write('packages:\n\n  safe-a@1.0.0:\n    resolution: {integrity: sha512-fake}\n')
    mismatch = os.path.join(workdir, 'mismatch.yaml')
    with open(mismatch, 'w', encoding='utf-8') as handle:
        handle.write("lockfileVersion: '9.0'\n\npackages:\n\n  safe-a@1.0.0:\n    engines: {node: '>=1'}\n")

    print('▶ 自检（桩 registry，不碰网络）')
    run('lockfileVersion 不是 9.x 就拒绝解析', ['--lockfile', future], USAGE)
    run('没有 lockfileVersion 就拒绝解析', ['--lockfile', headless], USAGE)
    run('键数与 resolution 行数不等就拒绝判定', ['--lockfile', mismatch], USAGE)
    run('--audit-level 只收四档', ['--lockfile', clean, '--audit-level', 'bogus'], USAGE)
    run('干净依赖图放行', ['--lockfile', clean], OK, want_in=['没有 critical 及以上'])
    run('critical 阻断', ['--lockfile', critical], BLOCKED,
        want_in=['critical', 'vulny@1.0.0', '阻断'])
    run('低于阈值的只报告不阻断', ['--lockfile', moderate], OK,
        want_in=['moderate', '只报告，不阻断', '没有 critical 及以上'])
    run('阈值调到 low 时 moderate 也阻断', ['--lockfile', moderate, '--audit-level', 'low'],
        BLOCKED, want_in=['moderate'])
    run('同名多版本定位到中招的那个版本', ['--lockfile', both], BLOCKED,
        want_in=['vulny@1.0.0  受影响区间 <2.0.0'], want_not_in=['vulny@1.0.0,2.5.0  受影响区间 <2.0.0'])
    run('未知严重度按最高档阻断', ['--lockfile', unknown], BLOCKED, want_in=['critical', 'weird'])
    run('--chunk 与 --workers 只收正整数', ['--lockfile', clean, '--chunk', '0'], USAGE)
    run('分片切到 1 个包也不漏包（并发路径）', ['--lockfile', mixed, '--chunk', '1'], BLOCKED,
        want_in=['vulny', 'weird'])
    state['mode'] = 'boom'
    run('端点取不到数据时 fail closed', ['--lockfile', clean, '--rounds', '1'], NO_DATA,
        want_in=['取不到数据'], want_not_in=['没有 critical 及以上'])
    state['mode'] = 'slow'
    run('单次请求超时、重试用尽时 fail closed',
        ['--lockfile', clean, '--rounds', '1', '--request-timeout', '0.3'], NO_DATA,
        want_in=['取不到数据'], want_not_in=['没有 critical 及以上'])
    run('总预算不够再退避一轮时就 fail closed（不硬等到被 runner 掐掉）',
        ['--lockfile', clean, '--request-timeout', '0.3', '--budget-seconds', '5'], NO_DATA,
        want_in=['预算', '退避', '取不到数据'], want_not_in=['没有 critical 及以上'])
    run('预算已耗尽就不再发请求（fail closed）',
        ['--lockfile', clean, '--request-timeout', '5', '--budget-seconds', '0.5'], NO_DATA,
        want_in=['预算耗尽', '取不到数据'], want_not_in=['没有 critical 及以上'])
    state['mode'] = 'ok'
    server.shutdown()

    if failures:
        print(f'❌ 自检 {len(failures)} 条不通过', file=sys.stderr)
        for line in failures:
            print(f'   - {line}', file=sys.stderr)
        return 1
    print('✅ 自检通过')
    return OK


def report_timings(opts, wall):
    """把这次的耗时分布打出来。下一次调 --chunk/--workers 要有据可依，而不是再赌一轮 CI。"""
    if not TIMINGS:
        return
    ordered = sorted(TIMINGS)
    print(f"   bulk 请求 {len(ordered)} 次成功：最快 {ordered[0]:.1f}s / "
          f"中位 {ordered[len(ordered) // 2]:.1f}s / 最慢 {ordered[-1]:.1f}s，"
          f"墙钟 {wall:.1f}s（分片 {opts['chunk']} 个包、并发 {opts['workers']}、"
          f"单次上限 {float(opts['request-timeout']):.0f}s、总预算 "
          f"{float(opts['budget-seconds']):.0f}s）")


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] == ['--self-test']:
        return self_test()
    opts = parse_args(argv)
    wanted = read_lockfile(opts['lockfile'])
    url = opts['registry'].rstrip('/') + BULK_PATH
    total = sum(len(versions) for versions in wanted.values())
    print('▶ npm 依赖漏洞（GitHub Advisory DB / bulk 端点）')
    print(f"   {opts['lockfile']}：{len(wanted)} 个包名、{total} 个 name@version"
          f"；{opts['audit-level']} 及以上阻断")
    global DEADLINE, TIMINGS
    TIMINGS = []
    started = time.monotonic()
    DEADLINE = started + float(opts['budget-seconds'])
    try:
        rows = collect(url, wanted, opts)
    except NoData as exc:
        report_timings(opts, time.monotonic() - started)
        die(NO_DATA, f'❌ {exc}：这不是「没有漏洞」，是取不到数据')
    report_timings(opts, time.monotonic() - started)
    threshold = ORDER.index(opts['audit-level'])
    blocking = [row for row in rows if ORDER.index(row['severity']) >= threshold]
    reported = [row for row in rows if ORDER.index(row['severity']) < threshold]
    if reported:
        print(f"⚠️  低于 {opts['audit-level']} 的通告 {len(reported)} 条（只报告，不阻断）")
        render(reported)
        if IN_CI:
            print(f"::warning::{len(reported)} 条低于 {opts['audit-level']} 的依赖漏洞通告（不阻断）")
    if not blocking:
        print(f"✅ 没有 {opts['audit-level']} 及以上的已知漏洞")
        return OK
    print(f"❌ {opts['audit-level']} 及以上通告 {len(blocking)} 条（阻断）")
    render(blocking)
    if IN_CI:
        for row in blocking:
            print(f"::error::{row['severity']} {row['name']}@{','.join(row['versions'])} "
                  f"{row['url']}")
    return BLOCKED


sys.exit(main())
PY
