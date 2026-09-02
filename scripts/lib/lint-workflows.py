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


def _iter_steps(job: object) -> list[dict]:
    if not isinstance(job, dict):
        return []
    return [s for s in (job.get("steps") or []) if isinstance(s, dict)]


def _check_uses(where: str, ref: object, errors: list[str]) -> None:
    if not isinstance(ref, str) or _LOCAL_OR_DOCKER.match(ref):
        return
    if not _SHA_PINNED.search(ref):
        errors.append(f"{where}: uses 未钉 40 位 SHA：{ref}")


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
