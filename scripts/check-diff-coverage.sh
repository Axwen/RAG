#!/usr/bin/env bash
# 增量覆盖率门禁：本次改动新增/修改的代码行，有多少被测试执行到。
#
# 为什么全局阈值不够：vitest.config.ts 的 86/81/82/87 是**整体**比例。仓库越大，
# 一个全新的、完全没有测试的文件对整体的拉低就越小——加 50 行未测代码，整体可能只掉
# 0.4 个点，照样在阈值之上。全局阈值拦的是"整体退化"，拦不住"这次新增的没测"。
# 这条只看本次改动涉及的行，与仓库规模无关。
#
# 判据：本次改动的行里，属于被插桩的源码行（lcov 的 DA 记录）的那些，有多少 hits > 0。
# 不在 lcov 里的行一律不计——测试文件、配置、apps/web、prisma/seed.ts 已在覆盖率
# exclude 里，shell 与 YAML 本来就不插桩。所以"改了一堆脚本"不会被这条门禁误伤。
#
# 前置：先跑 pnpm run test:coverage（需要 coverage/lcov.info）。
#
# 用法：
#   bash scripts/check-diff-coverage.sh                    # origin/main..HEAD，空则退化为最近 1 条
#   bash scripts/check-diff-coverage.sh HEAD~3..HEAD
#   bash scripts/check-diff-coverage.sh --min 90
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

MIN=80
range=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --min)
      MIN="${2:?--min 需要一个数字}"
      shift 2
      ;;
    *)
      range="$1"
      shift
      ;;
  esac
done

LCOV='coverage/lcov.info'
if [[ ! -f "${LCOV}" ]]; then
  echo "❌ 缺少 ${LCOV}——先跑 \`pnpm run test:coverage\`" >&2
  exit 1
fi

recent_range() {
  if git rev-parse --verify --quiet 'HEAD~1^{commit}' >/dev/null; then
    echo 'HEAD~1..HEAD'
  else
    echo 'HEAD'
  fi
}

# 与 check-commits.sh 同一套退化逻辑：push 到 main 时 origin/main == HEAD，区间为空，
# 那样这条门禁就是空跑。自动选出的区间为空时退化为最近一条提交。
if [[ -z "${range}" ]]; then
  if git rev-parse --verify --quiet origin/main >/dev/null; then
    range="origin/main..HEAD"
  else
    range="$(recent_range)"
  fi
  if [[ -z "$(git diff --name-only "${range}")" ]]; then
    range="$(recent_range)"
  fi
fi

echo "▶ 增量覆盖率（区间 ${range}，阈值 ${MIN}%）"

PATCH="$(mktemp)"
# shellcheck disable=SC2064 # 要在设置 trap 时展开路径，而不是触发时
trap "rm -f '${PATCH}'" EXIT

git diff --unified=0 --no-color --diff-filter=d "${range}" -- '*.ts' '*.tsx' >"${PATCH}"
if [[ ! -s "${PATCH}" ]]; then
  echo "✅ 本次改动没有 TypeScript 源码变更，增量覆盖率不适用"
  exit 0
fi

python3 - "${PATCH}" "${LCOV}" "${MIN}" "$(pwd)" <<'PY'
import os, re, sys

patch_path, lcov_path, min_pct, repo_root = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4]

# ── 1. 从 unified=0 的 diff 里取出每个文件的新增行号 ────────────────────────────
added: dict[str, set[int]] = {}
current = None
hunk = re.compile(r'^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@')
with open(patch_path, encoding='utf-8', errors='replace') as fh:
    for line in fh:
        if line.startswith('+++ b/'):
            current = line[6:].rstrip('\n')
            added.setdefault(current, set())
        elif line.startswith('@@') and current is not None:
            m = hunk.match(line)
            if m:
                start = int(m.group(1))
                count = int(m.group(2) or 1)
                added[current].update(range(start, start + count))

added = {f: lines for f, lines in added.items() if lines}
if not added:
    print('✅ 无新增行')
    sys.exit(0)

# ── 2. 从 lcov 取每个文件被插桩的行及其命中次数 ────────────────────────────────
hits: dict[str, dict[int, int]] = {}
sf = None
with open(lcov_path, encoding='utf-8', errors='replace') as fh:
    for line in fh:
        line = line.strip()
        if line.startswith('SF:'):
            path = line[3:]
            if os.path.isabs(path):
                path = os.path.relpath(path, repo_root)
            sf = path.replace(os.sep, '/')
            hits.setdefault(sf, {})
        elif line.startswith('DA:') and sf is not None:
            num, _, count = line[3:].partition(',')
            try:
                hits[sf][int(num)] = int(float(count))
            except ValueError:
                pass
        elif line == 'end_of_record':
            sf = None

# ── 3. 交集：只算"既是本次新增、又被插桩"的行 ─────────────────────────────────
total = covered = 0
rows = []
for path in sorted(added):
    instrumented = hits.get(path)
    if not instrumented:
        continue  # 不在 lcov 里：被 coverage.exclude 排除，或不是被测源码
    lines = sorted(l for l in added[path] if l in instrumented)
    if not lines:
        continue
    miss = [l for l in lines if instrumented[l] == 0]
    total += len(lines)
    covered += len(lines) - len(miss)
    rows.append((path, len(lines), miss))

if total == 0:
    print('✅ 本次改动没有新增被插桩的源码行（改的是测试、配置或未纳入覆盖率的文件）')
    sys.exit(0)

pct = covered / total * 100
for path, n, miss in rows:
    line_pct = (n - len(miss)) / n * 100
    # 门禁看的是聚合值，所以单文件的标记不能用 ❌：一个 94% 的文件是通过的，
    # 给它打红叉只会训练人忽略红叉。⚠️ 表示"有未覆盖行但自身达标"。
    mark = '✅' if not miss else ('⚠️ ' if line_pct + 1e-9 >= min_pct else '❌')
    print(f'  {mark} {path}: {n - len(miss)}/{n} 行（{line_pct:.0f}%）')
    if miss:
        # 直接给未覆盖的行号——这是唯一能直接动手的信息
        shown = ', '.join(str(m) for m in miss[:20])
        more = f' …还有 {len(miss) - 20} 行' if len(miss) > 20 else ''
        print(f'      未覆盖行: {shown}{more}')

print(f'新增 {total} 行被插桩代码，覆盖 {covered} 行（{pct:.2f}%），阈值 {min_pct:.0f}%')
if pct + 1e-9 < min_pct:
    # 管道里 stdout 是块缓冲、stderr 不缓冲，不 flush 的话失败结论会跑到逐文件明细前面
    sys.stdout.flush()
    print(f'❌ 增量覆盖率 {pct:.2f}% 低于阈值 {min_pct:.0f}%——新增代码要么补测试，'
          '要么在 vitest.config.ts 的 coverage.exclude 里说明为什么不该计入', file=sys.stderr)
    sys.exit(1)
print('✅ 增量覆盖率通过')
PY
