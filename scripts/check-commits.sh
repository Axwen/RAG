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
# 空区间不算通过：push 到 main 时 actions/checkout 会把本地 main 指到 origin/main，
# 默认区间 origin/main..HEAD 恒为空。前 10 次 CI 运行就是这样"通过"的，日志原文
# 「范围 origin/main..HEAD 内无非 merge 提交」——零条提交被检查，门禁是空的。
# 现在自动选出的区间为空时退化为检查最近一条，永远至少检查一条。
#
# 用法：
#   bash scripts/check-commits.sh              # origin/main..HEAD，空则退化为最近 1 条
#   bash scripts/check-commits.sh <range>      # 例如 HEAD~5..HEAD
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# 最近一条提交的区间；仓库只有一条提交时 HEAD~1 不存在，退化为 HEAD
recent_range() {
  if git rev-parse --verify --quiet 'HEAD~1^{commit}' >/dev/null; then
    echo 'HEAD~1..HEAD'
  else
    echo 'HEAD'
  fi
}

range="${1:-}"
explicit=1
if [[ -z "${range}" ]]; then
  explicit=0
  if git rev-parse --verify --quiet origin/main >/dev/null; then
    range="origin/main..HEAD"
  else
    range="$(recent_range)"
    echo "ℹ️  无 origin/main，退化为检查最近 1 条提交"
  fi
fi

# 端点必须都能解析：main 被 force push 过时 CI 传进来的 github.event.before 可能已不可达，
# git log 会报 bad revision，把一条本可退化的检查变成硬失败。
if [[ "${range}" == *..* ]]; then
  for endpoint in "${range%%..*}" "${range##*..}"; do
    if ! git rev-parse --verify --quiet "${endpoint}^{commit}" >/dev/null; then
      echo "⚠️  区间端点 ${endpoint} 无法解析，退化为检查最近 1 条提交" >&2
      range="$(recent_range)"
      explicit=0
      break
    fi
  done
fi

mapfile -t subjects < <(git log --no-merges --pretty=%s "${range}")

# 自动选出的区间为空 → 退化，而不是宣布通过
if [[ ${#subjects[@]} -eq 0 && "${explicit}" -eq 0 && "${range}" != "$(recent_range)" ]]; then
  echo "ℹ️  ${range} 内无提交（push 到 main 时 origin/main == HEAD），退化为检查最近 1 条"
  range="$(recent_range)"
  mapfile -t subjects < <(git log --no-merges --pretty=%s "${range}")
fi

if [[ ${#subjects[@]} -eq 0 ]]; then
  if [[ "${explicit}" -eq 1 ]]; then
    echo "✅ 提交信息检查通过（显式区间 ${range} 内无非 merge 提交）"
    exit 0
  fi
  echo "❌ ${range} 内没有可检查的提交——这个检查不能以空区间宣布通过" >&2
  exit 1
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
