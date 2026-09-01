#!/usr/bin/env bash
# 从 CHANGELOG.md 抽出某个版本段落，作为 GitHub Release 正文。
#
# 为什么不用自动生成的 commit 列表：提交信息是给维护者看的，Release notes 是给使用者
# 看的。CHANGELOG 已经按 Keep a Changelog 分了 Added/Fixed，直接用它，避免同一件事
# 写两遍还写不一致。
#
# 用法：bash scripts/release-notes.sh v0.1.0
#      bash scripts/release-notes.sh            # 取 [Unreleased] 段
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

TAG="${1-}"
# 标签 v0.1.0 对应 CHANGELOG 里的 [0.1.0]；无参数时取 [Unreleased]
WANT="${TAG#v}"
WANT="${WANT:-Unreleased}"

if [[ ! -f CHANGELOG.md ]]; then
  echo "❌ 缺少 CHANGELOG.md" >&2
  exit 1
fi

body="$(
  awk -v want="${WANT}" '
    # 段落起点：## [want]
    $0 ~ "^## \\[" want "\\]" { inside = 1; next }
    # 下一个 ## 标题即段落终点
    inside && /^## / { exit }
    inside { print }
  ' CHANGELOG.md
)"

# 去掉首尾空行
body="$(printf '%s\n' "${body}" | sed -e '/./,$!d' | tac | sed -e '/./,$!d' | tac)"

if [[ -z "${body}" ]]; then
  echo "❌ CHANGELOG.md 中没有 [${WANT}] 段落（标签与 CHANGELOG 必须对齐）" >&2
  exit 1
fi

printf '%s\n' "${body}"
