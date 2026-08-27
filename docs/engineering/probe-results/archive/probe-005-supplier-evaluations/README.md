# PROBE-005 供应商评估历史

本目录保存未被选为当前 MVP 基线的供应商实验、重复运行和方法勘误。它们是 ADR-0017 供应商取舍的否决/对比证据，不是当前主结果。

- `agentrouter`：Chat Completions 不适配；Responses 协议可用但存在 UA 门禁、提示词注入、模型身份和可用性问题。
- `stepfun`：第一方身份和契约表现良好，但 `step-3.5-flash-2603` 在合并 40 样本下 p95=3.752s，未满足 3.5s 高风险预算，因此暂不替换 fluxionai。

当前结果入口见 [../../README.md](../../README.md)，当前供应商基线见 [ADR-0017](../../../../adr/0017-mvp-cloud-model-and-budget.md)。
