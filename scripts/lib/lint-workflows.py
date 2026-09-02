#!/usr/bin/env python3
"""工作流 YAML 基线检查——只用标准库 + PyYAML，不下载任何东西。

存在的理由：check-workflows.sh 的 actionlint 那一半在本地会因为"没装"而整段跳过，
于是本地对 740 行工作流的检查是零。这一层补上其中不需要 actionlint 也能做的部分，
让下面这类错误在本地当场暴露，而不是推上去看 GitHub 报 Invalid workflow file：

  1. YAML 不可解析。步骤名里出现裸的 "run: "（冒号加空格）就会触发——YAML 把它
     当成映射键。这批改动里真出现过一次，整个 ci.yml 的四个 job 都不会跑。
  2. needs 指向不存在的 job。打错一个字，那个 job 永远不执行，而不是报错。
  3. ${{ steps.<id>.… }} 引用了没有 id 的步骤。表达式求值成空字符串，静默错。
  4. uses 没钉 40 位 commit SHA。浮动 tag 是可变引用：同一个 tag 明天可以指向
     别的代码。Dependabot 换 SHA 时会保留 `# vX` 注释，所以这条不妨碍它工作。
  5. 需要全历史的命令跑在浅克隆上。`actions/checkout` 默认 `fetch-depth: 1`，而
     `check-secrets.sh`（扫 HEAD 全部祖先提交）与 `check-commits.sh`（比较
     `origin/main..HEAD`）都要求历史在本地；`pnpm run verify` 把前者串在链里。
     release.yml 的 guard 就是这样被抓到的：它重跑全量 verify，checkout 却没写
     fetch-depth——而那条工作流从没执行过，第一次推 v* 标签才会死。

不做的事：表达式语法、上下文可用性、run: 块里的 shell——那些交给 actionlint。
"""

from __future__ import annotations

import re
import sys

import yaml

# 本地复合 action（./.github/actions/x）与 docker 镜像引用不适用 SHA 规则
_LOCAL_OR_DOCKER = re.compile(r"^(\./|docker://)")
_SHA_PINNED = re.compile(r"@[0-9a-f]{40}$")
_STEP_REF = re.compile(r"steps\.([A-Za-z0-9_-]+)\.")

# 跑到这些东西的 job 必须有完整历史。verify 在链里串了 check:secrets，所以也算。
_NEEDS_FULL_HISTORY = (
    "check-secrets.sh",
    "check:secrets",
    "check-commits.sh",
    "check:commits",
    "pnpm run verify",
)


def _iter_steps(job: object) -> list[dict]:
    if not isinstance(job, dict):
        return []
    return [s for s in (job.get("steps") or []) if isinstance(s, dict)]


def _check_uses(where: str, ref: object, errors: list[str]) -> None:
    if not isinstance(ref, str) or _LOCAL_OR_DOCKER.match(ref):
        return
    if not _SHA_PINNED.search(ref):
        errors.append(f"{where}: uses 未钉 40 位 SHA：{ref}")


def _check_full_history(where: str, steps: list[dict], errors: list[str]) -> None:
    """跑了需要全历史的命令，就必须显式 fetch-depth: 0。

    只看这一个 job 内部：checkout 的深度不跨 job 传递。多个 checkout 时要求每个都写，
    因为后一个会覆盖前一个的工作区。
    """
    hits = sorted(
        {
            needle
            for step in steps
            if isinstance(step.get("run"), str)
            for needle in _NEEDS_FULL_HISTORY
            if needle in step["run"]
        }
    )
    if not hits:
        return

    checkouts = [
        s for s in steps if isinstance(s.get("uses"), str) and "actions/checkout@" in s["uses"]
    ]
    if not checkouts:
        errors.append(f"{where}: 跑了 {hits} 却没有 checkout 步骤")
        return
    for step in checkouts:
        with_ = step.get("with")
        depth = with_.get("fetch-depth") if isinstance(with_, dict) else None
        if str(depth) != "0":
            errors.append(
                f"{where}: 跑了 {hits}（需要全历史），"
                f"但 checkout 的 fetch-depth 是 {depth!r}——必须显式写 0"
            )


def check(path: str) -> tuple[list[str], int, int]:
    """返回 (错误列表, job 数, step 数)。"""
    errors: list[str] = []
    with open(path, encoding="utf-8") as fh:
        raw = fh.read()

    try:
        doc = yaml.safe_load(raw)
    except yaml.YAMLError as exc:
        return [f"{path}: YAML 不可解析——{exc}"], 0, 0

    if not isinstance(doc, dict):
        return [f"{path}: 顶层不是映射"], 0, 0

    jobs = doc.get("jobs")
    if not isinstance(jobs, dict) or not jobs:
        return [f"{path}: 没有 jobs"], 0, 0

    nsteps = 0
    for jid, job in jobs.items():
        if not isinstance(job, dict):
            errors.append(f"{path}: job {jid} 不是映射")
            continue

        needs = job.get("needs") or []
        if isinstance(needs, str):
            needs = [needs]
        for dep in needs:
            if dep not in jobs:
                errors.append(f"{path}: job {jid} 的 needs 指向不存在的 job「{dep}」")

        # 可复用工作流：jobs.<id>.uses
        _check_uses(f"{path} job {jid}", job.get("uses"), errors)

        steps = _iter_steps(job)
        nsteps += len(steps)
        for step in steps:
            _check_uses(f"{path} job {jid}", step.get("uses"), errors)

        _check_full_history(f"{path} job {jid}", steps, errors)

        # 只在这个 job 的范围内校验 steps.<id> 引用：step id 的作用域是 job
        ids = {s["id"] for s in steps if isinstance(s.get("id"), str)}
        for ref in sorted(set(_STEP_REF.findall(yaml.safe_dump(job, allow_unicode=True)))):
            if ref not in ids:
                errors.append(f"{path}: job {jid} 引用了未定义的 step id「{ref}」")

    return errors, len(jobs), nsteps


def main(argv: list[str]) -> int:
    if not argv:
        print("用法：lint-workflows.py <workflow.yml>...", file=sys.stderr)
        return 2

    failed = False
    for path in argv:
        errors, njobs, nsteps = check(path)
        if errors:
            failed = True
            for msg in errors:
                print(f"  ❌ {msg}", file=sys.stderr)
        else:
            print(f"  ✅ {path}（{njobs} job / {nsteps} step）")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
