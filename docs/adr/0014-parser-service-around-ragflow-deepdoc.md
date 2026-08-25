---
status: accepted
---

# 用独立 Parser Service 包装 RAGFlow DeepDOC

MVP 不复制 DeepDOC 单个源码文件，也不把完整 RAGFlow 作为业务后端，而是运行独立 Python Parser Service，内部包装固定版本的 RAGFlow DeepDOC 和 OCR 能力。NestJS 与 Worker 只依赖稳定的 `ParseInput -> ParseArtifact` 契约，从而保留复杂 PDF、扫描件和坐标解析能力，同时隔离 RAGFlow 的内部包、数据库和任务模型。
