---
status: accepted
---

# TypeScript 控制面与 Python 解析/模型运行时

系统使用 TypeScript 实现 Web、业务接口、权限、任务编排、检索编排和引用治理，使用独立 Python 运行时承载 DeepDOC、OCR、Embedding、Reranker 等成熟 AI 能力。该方案在统一产品领域模型的同时保留 Python 文档解析和模型生态，避免为追求全 TypeScript 重写高风险算法模块；两侧通过稳定适配器协议集成，允许后续替换具体实现。
