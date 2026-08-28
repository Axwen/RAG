"""解析服务健康入口与资源边界 smoke test。"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from rag_parser import __version__
from rag_parser.app import create_app
from rag_parser.settings import ParserSettings


@pytest.fixture()
def client() -> TestClient:
    return TestClient(create_app(ParserSettings()))


def test_package_version() -> None:
    assert __version__ == "0.0.0"


def test_live(client: TestClient) -> None:
    response = client.get("/health/live")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "parser"}


def test_ready_exposes_frozen_limits(client: TestClient) -> None:
    response = client.get("/health/ready")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "up"
    assert body["limits"]["concurrency"] == 1
    assert body["limits"]["rssWarningBytes"] == 8 * 1024**3


def test_concurrency_above_one_is_rejected() -> None:
    with pytest.raises(ValidationError):
        ParserSettings(concurrency=2)


def test_settings_read_env_prefix(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PARSER_PORT", "8200")
    assert ParserSettings().port == 8200
