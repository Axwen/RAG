#!/usr/bin/env bash
# 密钥扫描：gitleaks 扫**全部历史**，且三种触发事件下跑的是同一条命令。
#
# 为什么不用 gitleaks/gitleaks-action：它按事件名自行决定扫描范围。实测（2026-09-02，
# main 上一次"成功"的运行）它拼出来的命令是
#
#   gitleaks detect ... --log-opts=--no-merges --first-parent <before>^..<sha>
#   INF 2 commits scanned.
#
# 也就是只扫这次推送里的 2 条提交。而这个 job 从建立起就叫「全历史密钥扫描」，
# 理由写在 ci-cd.md §2.3：「.env 被 gitignore」与「从没被提交过」是两件事，只有扫全
# 历史能确认。checkout 的 fetch-depth: 0 把历史拉全了，范围却又被 --log-opts 收窄回
# 去——门禁名字与实际行为不符，和 check:commits 空转是同一类缺陷。
# 同一个 action 在 pull_request 上更糟：它改走 ScanPullRequest，要读 PR 的提交列表，
# 默认只读 token 没有 pull-requests 权限，于是直接
# `RequestError [HttpError]: Resource not accessible by integration`——而 gitleaks 是
# required check，等于每个 PR 上都挂一个永远红的门禁（三个 Dependabot PR 全是这样红的）。
#
# 直接调二进制就没有这些隐式行为：`gitleaks detect` 不带 --log-opts 时遍历全部提交。
# 附带好处是不再依赖那个 action 的许可证策略（它的日志会打印
# 「[Axwen] is an individual user. No license key is required.」——个人账号免许可证，
# 但迁到 organization 下就要 GITLEAKS_LICENSE），也不再受它 Node 20 运行时的弃用告警影响。
#
# 严格程度与 check-shell.sh / check-workflows.sh 一致：本地缺 gitleaks 降级为警告，
# CI 用 --strict 自行下载钉死版本并校验 sha256。
#
# 用法：
#   bash scripts/check-secrets.sh            # 本地；没装 gitleaks 只警告
#   bash scripts/check-secrets.sh --strict   # CI；必须真扫，缺就下载钉死版本
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# 版本与校验和取自 gitleaks/gitleaks 的 release 资产清单（v8.30.1，2026-09-02 记录）。
# 升级时同时改版本号与对应校验和；校验和写死在这里，而不是运行时从同一个来源拉
# （那样上游资产被替换会静默通过）。这条纪律对检查工具自己和对 action 一视同仁。
GITLEAKS_VERSION='8.30.1'
sha_for() {
  case "$1" in
    linux_x64) echo '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb' ;;
    linux_arm64) echo 'e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080' ;;
    darwin_arm64) echo 'b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5' ;;
    *) return 1 ;;
  esac
}

STRICT=0
[[ "${1-}" == "--strict" ]] && STRICT=1

if [[ ! -f .gitleaks.toml ]]; then
  echo "❌ 缺少 .gitleaks.toml——放行清单是这条门禁的判据，不能缺省" >&2
  exit 1
fi

BIN=''
if command -v gitleaks >/dev/null 2>&1; then
  BIN="$(command -v gitleaks)"
elif [[ "${STRICT}" -eq 0 ]]; then
  echo "⚠️  未安装 gitleaks，跳过密钥扫描"
  echo "    安装：https://github.com/gitleaks/gitleaks/releases/tag/v${GITLEAKS_VERSION}"
  echo "    或跑 bash scripts/check-secrets.sh --strict（自行下载钉死版本）"
  exit 0
else
  case "$(uname -s)/$(uname -m)" in
    Linux/x86_64) platform='linux_x64' ;;
    Linux/aarch64 | Linux/arm64) platform='linux_arm64' ;;
    Darwin/arm64) platform='darwin_arm64' ;;
    *)
      echo "❌ 无预置校验和的平台：$(uname -s)/$(uname -m)；请自行安装 gitleaks 后重跑" >&2
      exit 1
      ;;
  esac

  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064 # 此处就是要在设置 trap 时展开 tmp，而不是触发时
  trap "rm -rf '${tmp}'" EXIT

  asset="gitleaks_${GITLEAKS_VERSION}_${platform}.tar.gz"
  url="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${asset}"
  echo "▶ 下载 gitleaks v${GITLEAKS_VERSION}（${platform}）"
  if ! curl -fsSL --retry 3 -o "${tmp}/${asset}" "${url}"; then
    echo "❌ 下载失败：${url}" >&2
    exit 1
  fi

  want="$(sha_for "${platform}")"
  got="$(sha256sum "${tmp}/${asset}" | cut -d' ' -f1)"
  if [[ "${got}" != "${want}" ]]; then
    echo "❌ gitleaks 校验和不匹配——上游资产被替换，或下载损坏。" >&2
    echo "   期望 ${want}" >&2
    echo "   实得 ${got}" >&2
    exit 1
  fi
  tar -xzf "${tmp}/${asset}" -C "${tmp}" gitleaks
  BIN="${tmp}/gitleaks"
fi

# 浅克隆下"全历史"是假的：CI 必须 fetch-depth: 0，本地也可能在浅克隆里跑。
if [[ "$(git rev-parse --is-shallow-repository)" == 'true' ]]; then
  echo "❌ 当前是浅克隆，扫不到全历史（CI 里请给 checkout 加 fetch-depth: 0）" >&2
  exit 1
fi

commits="$(git rev-list --count HEAD)"
echo "▶ gitleaks v${GITLEAKS_VERSION}：HEAD 全部祖先提交（${commits} 条）"

# 用 `git` 子命令而不是 `detect`：后者自 v8.19.0 起已废弃（仍能跑，但从 --help 里隐掉了），
# 支持的三种模式是 git / dir / stdin。路径是位置参数，不是 --source。
# 不传 --log-opts，所以遍历 HEAD 的全部祖先提交，与触发事件无关——这才是这个 job 名字
# 承诺的东西。（CI 侧的前提是 checkout 带 fetch-depth: 0，否则历史根本不在本地。）
# --redact 是 uint，裸给等于 100：命中时只报规则名与位置，不把凭证写进公开日志。
# --exit-code 2 把"有命中"和"工具自身出错"分开：默认是 1，那样两者不可区分。
set +e
"${BIN}" git . --config .gitleaks.toml --redact --no-banner --verbose --exit-code 2
code=$?
set -e

case "${code}" in
  0) echo "✅ 全历史（${commits} 条提交）未检出凭证" ;;
  2)
    echo "❌ 全历史里检出凭证。凭证一旦进过历史就必须当作已泄漏：先在源端吊销/轮换，" >&2
    echo "   再决定是否改写历史。确认是刻意无效的占位符或测试夹具，才加进 .gitleaks.toml。" >&2
    exit 1
    ;;
  *)
    echo "❌ gitleaks 自身执行失败（exit ${code}）" >&2
    exit 1
    ;;
esac

# 明确不扫工作区（不加 --no-git）：那样会扫到被 gitignore 的真 .env，而本机有一份带真
# 口令的 .env 是**正常状态**，不是缺陷。让 verify 因此变红，只会训练人忽略这条门禁——
# 和永远红的 dependency-review 是同一个错。git 忽略的文件进不了仓库，本就不在这条门禁
# 的射程内；"提交之前拦一次"属于 pre-commit 钩子（gitleaks protect --staged）的职责。
