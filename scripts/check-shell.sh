#!/usr/bin/env bash
# Shell 脚本静态检查。
#
# 为什么单独一条：本仓库的编排、初始化与冒烟都是 bash（infra/compose/init/、scripts/），
# 它们是"能不能起来"的关键路径，却完全在 TypeScript 工具链的视野之外。未加引号的
# 变量展开、误判的退出码、set -e 下被吞掉的失败——这些只有 shellcheck 会拦。
#
# 严格程度：shellcheck 缺失时本地降级为警告（不阻断日常开发），CI 用 --strict 强制存在。
# 判据：任何 warning 及以上即失败（-S warning）；info/style 只提示。
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

STRICT=0
[[ "${1-}" == "--strict" ]] && STRICT=1

if ! command -v shellcheck >/dev/null 2>&1; then
  if [[ "${STRICT}" -eq 1 ]]; then
    echo "❌ 未安装 shellcheck（--strict 要求必须存在）" >&2
    exit 1
  fi
  echo "⚠️  未安装 shellcheck，跳过 shell 检查（apt-get install shellcheck）"
  exit 0
fi

mapfile -t files < <(
  git ls-files -- '*.sh' 'infra/compose/init/*' 2>/dev/null |
    while read -r f; do
      [[ -f "${f}" ]] || continue
      case "${f}" in
        *.sh) printf '%s\n' "${f}" ;;
        *) head -1 "${f}" | grep -q '^#!.*\(bash\|sh\)' && printf '%s\n' "${f}" ;;
      esac
    done | sort -u
)

if [[ "${#files[@]}" -eq 0 ]]; then
  echo "⚠️  未找到 shell 脚本"
  exit 0
fi

echo "▶ shellcheck（${#files[@]} 个脚本，阈值 warning）"
if shellcheck --severity=warning --external-sources --shell=bash "${files[@]}"; then
  echo "✅ shellcheck 通过"
  exit 0
fi
echo "❌ shellcheck 未通过（上面每条都带 SCxxxx 编号，wiki.koalaman/SCxxxx 有解释）" >&2
exit 1
