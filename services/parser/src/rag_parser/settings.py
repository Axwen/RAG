"""解析服务配置。

资源边界来自 ADR-0025：DeepDOC 并发固定为 1，RSS 警戒 8 GiB。
T0 只让这些边界成为可校验配置，运行时强制在 T10。
"""

from __future__ import annotations

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class ParserSettings(BaseSettings):
    """从环境变量读取的解析服务配置。"""

    model_config = SettingsConfigDict(env_prefix="PARSER_", extra="ignore")

    port: int = Field(default=8100, ge=1, le=65535)
    log_level: str = Field(default="info")

    #: DeepDOC 并发上限。阶段 1 冻结为 1，放宽必须先改 ADR。
    concurrency: int = Field(default=1, ge=1, le=1)

    #: RSS 警戒线（字节）。超过即告警，不静默继续吃内存。
    rss_warning_bytes: int = Field(default=8 * 1024**3, gt=0)


def load_settings() -> ParserSettings:
    """加载配置；非法值直接抛出，不静默回退默认值。"""
    return ParserSettings()
