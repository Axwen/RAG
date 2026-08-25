---
status: superseded
superseded-by: 0025-data-class-routing-enforcement-point.md
---

# 按数据等级路由模型执行区

> 本 ADR 的约束继续有效，但执行载体已由 [ADR-0025](0025-data-class-routing-enforcement-point.md) 取代：阶段 1 不部署独立模型网关，强制执行点是 NestJS 内部 `ModelAdapter` 的准入层。下文保留原始决策文本，不做改写。

普通资料可以调用批准的云模型，敏感资料及其查询、证据和衍生内容只能进入企业网络内的本地模型执行区。路由由服务端模型网关根据数据等级强制执行，而不是由用户、前端或 Prompt 自由选择；当本地模型不可用时，敏感请求必须明确失败或仅返回受控检索结果，不能降级到云模型。
