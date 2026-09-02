#!/usr/bin/env bash
# 工作流 YAML 静态检查（actionlint）。
#
# 为什么需要单独一条：仓库里 18 个 shell 脚本过 shellcheck，而 740 行工作流 YAML
# 一个检查都没有——它偏偏是最容易写错、又最难在本地复现的一类代码。首跑那次
# `astral-sh/setup-uv@v10` 不存在（该 action 自 v8 起不再发布浮动大版本标签），
# 是推上去才知道的；而每个 `run:` 块里的 shell 此前完全在 check-shell.sh 的视野之外。
#
# actionlint 覆盖：on/jobs/needs 结构、`if:` 与 `${{ }}` 表达式的语法与上下文可用性、
# matrix 引用、废弃的 set-output/save-state，并把每个 run: 块交给 shellcheck。
#
# 严格程度与 check-shell.sh 一致：本地缺 actionlint 降级为警告（不阻断日常开发），
# CI 用 --strict——此时自行下载钉死版本的二进制并校验 sha256，不执行上游的 install 脚本、
# 也不接受浮动版本（"钉死上游"这条纪律不能只对 action 生效，对检查工具自己也一样）。
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# 版本与校验和取自 rhysd/actionlint 的 release 资产清单（v1.7.12，2026-09-02 记录）。
# 升级时同时改版本号与对应校验和；校验和写死在这里，而不是运行时从同一个来源拉，
# 这样上游资产被替换会当场失败而不是静默通过。
ACTIONLINT_VERSION='1.7.12'
sha_for() {
  case "$1" in
    linux_amd64) echo '8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8' ;;
    linux_arm64) echo '325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6' ;;
    darwin_arm64) echo 'aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f' ;;
    *) return 1 ;;
  esac
}

STRICT=0
[[ "${1-}" == "--strict" ]] && STRICT=1

mapfile -t files < <(git ls-files -- '.github/workflows/*.yml' '.github/workflows/*.yaml' | sort)
if [[ "${#files[@]}" -eq 0 ]]; then
  echo "⚠️  未找到工作流文件"
  exit 0
fi

# 基线检查：不依赖任何下载，永远跑。
#
# 为什么必须有这一层：原来本地没装 actionlint 就整段跳过，等于本地零检查。这批改动里
# 有一个步骤名写成 `name: 工作流 YAML 静态检查（actionlint + run: 块的 shellcheck）`——
# 名字里的 "run: " 是冒号加空格，YAML 会把它当成映射键，整个 ci.yml 直接不可解析
# （GitHub 上表现为 Invalid workflow file，四个 job 一个都不会跑）。本地跳过 + CI 才
# 报错，正是这条脚本要消除的那种反馈延迟，所以把"能用标准库做的那部分"前移到这里。
echo "▶ 基线（${#files[@]} 个工作流：YAML 可解析 / needs 与 step id 引用 / uses 钉 SHA）"
if ! python3 -c 'import yaml' >/dev/null 2>&1; then
  echo "⚠️  python3 缺 PyYAML，跳过基线检查（--strict 下 actionlint 会覆盖同类问题）"
elif ! python3 scripts/lib/lint-workflows.py "${files[@]}"; then
  echo "❌ 工作流基线检查未通过" >&2
  exit 1
fi

BIN=''
if command -v actionlint >/dev/null 2>&1; then
  BIN="$(command -v actionlint)"
elif [[ "${STRICT}" -eq 0 ]]; then
  echo "⚠️  未安装 actionlint，跳过工作流检查"
  echo "    安装：go install github.com/rhysd/actionlint/cmd/actionlint@v${ACTIONLINT_VERSION}"
  echo "    或跑 bash scripts/check-workflows.sh --strict（自行下载钉死版本）"
  exit 0
else
  case "$(uname -s)/$(uname -m)" in
    Linux/x86_64) platform='linux_amd64' ;;
    Linux/aarch64 | Linux/arm64) platform='linux_arm64' ;;
    Darwin/arm64) platform='darwin_arm64' ;;
    *)
      echo "❌ 无预置校验和的平台：$(uname -s)/$(uname -m)；请自行安装 actionlint 后重跑" >&2
      exit 1
      ;;
  esac

  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064 # 此处就是要在设置 trap 时展开 tmp，而不是触发时
  trap "rm -rf '${tmp}'" EXIT

  asset="actionlint_${ACTIONLINT_VERSION}_${platform}.tar.gz"
  url="https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/${asset}"
  echo "▶ 下载 actionlint v${ACTIONLINT_VERSION}（${platform}）"
  if ! curl -fsSL --retry 3 -o "${tmp}/${asset}" "${url}"; then
    echo "❌ 下载失败：${url}" >&2
    exit 1
  fi

  want="$(sha_for "${platform}")"
  got="$(sha256sum "${tmp}/${asset}" | cut -d' ' -f1)"
  if [[ "${got}" != "${want}" ]]; then
    echo "❌ actionlint 校验和不匹配——上游资产被替换，或下载损坏。" >&2
    echo "   期望 ${want}" >&2
    echo "   实得 ${got}" >&2
    exit 1
  fi
  tar -xzf "${tmp}/${asset}" -C "${tmp}" actionlint
  BIN="${tmp}/actionlint"
fi

if ! command -v shellcheck >/dev/null 2>&1; then
  # 不是硬失败：actionlint 本体的检查仍然有价值，但要说清少了哪一半
  echo "⚠️  未安装 shellcheck，run: 块内的 shell 不会被检查"
fi

echo "▶ actionlint（${#files[@]} 个工作流）"
if "${BIN}" -color "${files[@]}"; then
  echo "✅ actionlint 通过"
  exit 0
fi
echo "❌ actionlint 未通过（每条都带规则名，rhysd.github.io/actionlint/ 有逐条解释）" >&2
exit 1
