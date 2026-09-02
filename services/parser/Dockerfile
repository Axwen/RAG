# 阶段 1 Parser 服务镜像（T0 构建入口）。
#
# 探针阶段的 Dockerfile 仍保留为可丢弃证据，不充当此镜像。
# 依赖用 uv 冻结安装；DeepDOC 与其原生依赖在 T4 加入，届时再引入系统级构建依赖。
FROM python:3.14.7-slim-bookworm AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv

# uv 由官方发布镜像提供固定版本，避免在构建期从网络脚本安装
COPY --from=ghcr.io/astral-sh/uv:0.12.5 /uv /usr/local/bin/uv

WORKDIR /app

# 先只复制清单，最大化依赖层缓存命中
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY src ./src
RUN uv sync --frozen --no-dev

ENV PATH="/opt/venv/bin:$PATH" \
    PARSER_PORT=8100

# 不以 root 运行；解析的是不可信文档内容
RUN useradd --create-home --uid 10001 parser && chown -R parser:parser /app /opt/venv
USER parser

EXPOSE 8100

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8100/health/live', timeout=2).status == 200 else 1)"

CMD ["python", "-m", "rag_parser"]
