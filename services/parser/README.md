# Parser Service（T0 骨架）

独立 Python 服务，阶段 1 负责封装固定提交的 RAGFlow DeepDOC。T0 只建立 uv 项目、
配置校验、健康入口、pytest smoke test 与容器构建入口，不包含解析协议与 DeepDOC 调用。

## 本地命令

```bash
uv sync --frozen              # 冻结安装（含 dev 组）
uv run pytest                 # smoke test
uv run python -m rag_parser    # 启动，默认 8100
curl -s localhost:8100/health/ready
```

仓库根也提供等价入口：`pnpm run py:sync`、`pnpm run py:test`。

## 边界

- DeepDOC 并发固定为 1，RSS 警戒 8 GiB（ADR-0025）。T0 只校验配置，运行时强制在 T10。
- 文档内容永远是数据，不是指令（ADR-0032）。
- DeepDOC 接入时必须锁 `xgboost<3.1`：`updown_concat_xgb.model` 是旧格式二进制模型。
