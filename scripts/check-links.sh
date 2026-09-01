#!/usr/bin/env bash
# Markdown 相对链接与锚点检查。
#
# 为什么要有：本仓库的事实源是文档网络（PROJECT_STATE -> ADR -> 票据 -> 验收记录），
# 断链会让"事实源层级"失效——读者点过去是 404 时，只能回退到聊天记录，那正是要避免的。
# 探针收尾曾人工做过一次这个检查，这里把它变成可复跑的门禁。
#
# 检查范围：仓库内 Markdown 的相对链接（http(s)、mailto 与纯锚点跳过），
# 以及带 #anchor 的目标标题是否真实存在（按 GitHub 的 slug 规则近似）。
# 排除 references/（外部仓库快照）与 node_modules。
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

python3 - "$@" <<'PY'
import os, re, sys, unicodedata

EXCLUDE_DIRS = {'.git', 'node_modules', 'references', '.next', 'dist', '.uv-cache', 'coverage'}
LINK = re.compile(r'\[[^\]]*\]\(\s*([^)\s]+?)\s*(?:"[^"]*")?\)')
HEADING = re.compile(r'^(#{1,6})\s+(.*?)\s*#*\s*$')

def slug(text: str) -> str:
    """GitHub 的 heading -> anchor 近似：去 markdown 行内标记、小写、非字母数字/连字符/CJK 去掉、空格转连字符。"""
    t = re.sub(r'`([^`]*)`', r'\1', text)
    t = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', t)
    t = re.sub(r'[*_~]', '', t)
    t = t.strip().lower()
    out = []
    for ch in t:
        if ch.isspace():
            out.append('-')
        elif ch == '-' or ch.isalnum() or unicodedata.category(ch).startswith('L'):
            out.append(ch)
    return ''.join(out)

def md_files():
    for root, dirs, files in os.walk('.'):
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
        for f in files:
            if f.endswith('.md'):
                yield os.path.normpath(os.path.join(root, f))

anchors: dict[str, set[str]] = {}
def anchors_of(path: str) -> set[str]:
    if path not in anchors:
        s: set[str] = set()
        try:
            for line in open(path, encoding='utf-8'):
                m = HEADING.match(line)
                if m:
                    s.add(slug(m.group(2)))
        except OSError:
            pass
        anchors[path] = s
    return anchors[path]

problems = []
for path in sorted(md_files()):
    base = os.path.dirname(path)
    for lineno, line in enumerate(open(path, encoding='utf-8'), 1):
        for target in LINK.findall(line):
            if re.match(r'^(https?:|mailto:|#|<)', target):
                continue
            file_part, _, anchor = target.partition('#')
            if not file_part:
                continue
            resolved = os.path.normpath(os.path.join(base, file_part))
            if not os.path.exists(resolved):
                problems.append(f'{path}:{lineno}: 目标不存在 -> {target}')
                continue
            if anchor and resolved.endswith('.md') and slug(anchor) not in anchors_of(resolved):
                problems.append(f'{path}:{lineno}: 锚点不存在 -> {target}')

if problems:
    print(f'❌ Markdown 链接检查失败（{len(problems)} 项）：', file=sys.stderr)
    for p in problems:
        print('  ' + p, file=sys.stderr)
    sys.exit(1)
print(f'✅ Markdown 链接检查通过（{len(list(md_files()))} 个文件）')
PY
