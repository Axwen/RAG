"""本地启动入口：``uv run python -m rag_parser``。"""

from __future__ import annotations

import uvicorn

from .app import create_app
from .settings import load_settings


def main() -> None:
    settings = load_settings()
    uvicorn.run(
        create_app(settings),
        host="0.0.0.0",  # noqa: S104 容器内监听所有地址，由 Compose 端口映射控制暴露面
        port=settings.port,
        log_level=settings.log_level,
    )


if __name__ == "__main__":
    main()
