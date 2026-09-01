#!/usr/bin/env bash
# Conventional Commits 主题行检查。
#
# 为什么自己写而不是装 commitlint：本仓库的依赖策略是冻结安装 + 最小依赖，
# 为一条正则引入 @commitlint/cli 会带进上百个传递依赖。这个脚本本地与 CI 同一份，
# 无新增依赖。
#
# 规则（与仓库既有历史一致）：
#   <type>[(scope)][!]: <subject>
#   type ∈ feat|fix|docs|chore|refactor|perf|test|build|ci|style|revert
#   subject 非空，主题行 <= 72 字符（CJK 按显示宽度算 2）
#   允许 Merge/Revert 提交与 fixup!/squash! 直通
#
# 用法：
#   bash scripts/check-commits.sh              # 检查 origin/main..HEAD，无远端时退化为最近 1 条
#   bash scripts/check-commits.sh <range>      # 例如 HEAD~5..HEAD
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

range="${1:-}"
if [[ -z "${range}" ]]; then
  if git rev-parse --verify --quiet origin/main >/dev/null; then
    range="origin/main..HEAD"
  else
    range="HEAD~1..HEAD"
    echo "ℹ️  无 origin/main，退化为检查最近 1 条提交"
  fi
fi

mapfile -t subjects < <(git log --no-merges --pretty=%s "${range}")
if [[ ${#subjects[@]} -eq 0 ]]; then
  echo "✅ 提交信息检查通过（范围 ${range} 内无非 merge 提交）"
  exit 0
fi

TYPES='feat|fix|docs|chore|refactor|perf|test|build|ci|style|revert'
fail=0

# CJK 按 2 列计宽：72 字符的限制是给终端和 GitHub 列表看的，按字节或字符都会算错。
width() {
  python3 -c '
import sys, unicodedata
s = sys.argv[1]
print(sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in s))
' "$1"
}

for s in "${subjects[@]}"; do
  case "${s}" in
    Merge\ * | Revert\ * | fixup!* | squash!*) continue ;;
  esac
  if [[ ! "${s}" =~ ^(${TYPES})(\([a-z0-9._/-]+\))?!?:\ .+ ]]; then
    echo "❌ 主题行不符合 Conventional Commits: ${s}" >&2
    fail=1
    continue
  fi
  w="$(width "${s}")"
  if [[ "${w}" -gt 72 ]]; then
    echo "❌ 主题行过长（显示宽度 ${w} > 72）: ${s}" >&2
    fail=1
  fi
done

if [[ "${fail}" -ne 0 ]]; then
  echo >&2
  echo "格式：<type>[(scope)][!]: <subject>    type ∈ ${TYPES//|/, }" >&2
  exit 1
fi

echo "✅ 提交信息检查通过（${#subjects[@]} 条，范围 ${range}）"
