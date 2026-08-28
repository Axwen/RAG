"""解析服务 HTTP 入口。

T0 只提供健康入口：
- ``GET /health/live``  进程存活，不代表可以解析。
- ``GET /health/ready`` 就绪，附带冻结的资源边界，便于本地核对配置。

解析端点、DeepDOC 编排与产物协议在 T4；这里不放任何业务占位实现。
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI

from .settings import ParserSettings, load_settings


def create_app(settings: ParserSettings | None = None) -> FastAPI:
    """构造 FastAPI 应用。配置在启动时解析，非法即失败。"""
    resolved = settings if settings is not None else load_settings()
    app = FastAPI(title="rag-parser", version="0.0.0", docs_url=None, redoc_url=None)

    @app.get("/health/live")
    def live() -> dict[str, Any]:
        return {"status": "ok", "service": "parser"}

    @app.get("/health/ready")
    def ready() -> dict[str, Any]:
        return {
            "status": "up",
            "service": "parser",
            "limits": {
                "concurrency": resolved.concurrency,
                "rssWarningBytes": resolved.rss_warning_bytes,
            },
        }

    return app

