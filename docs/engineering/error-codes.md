# API 错误码

统一错误信封（T1a / devex 评审 DX-T3）：所有非 2xx 响应体固定五字段，
不再携带其他顶层键。

```json
{
  "code": "COMPATIBILITY_VIOLATION",
  "message": "兼容组合校验失败：……",
  "param": null,
  "doc_url": "docs/engineering/error-codes.md#compatibility_violation",
  "trace_id": "018f0000-0000-7000-8000-000000000abc"
}
```

- `code`：稳定错误码，客户端只依赖它做分支，新增码只追加不改义。
- `message`：人读消息，可直接展示；不包含堆栈或供应商原文。
- `param`：出错的请求参数或路径；与具体参数无关时为 `null`。
- `doc_url`：本文件对应锚点。
- `trace_id`：关联本次请求的日志与审计。优先复用请求头 `traceparent` 的
  trace-id，缺失或格式非法时由服务端生成 UUID；INTERNAL_ERROR 的堆栈只进
  日志，日志行带同一 `traceId`。

## 错误码清单

### VALIDATION_ERROR

HTTP 400。请求参数不合法（zod 校验失败、非法枚举、缺字段）。
修复：按 `message` 与 `param` 修正请求体；Manifest 字段口径见
[工程评审闭合记录 §4.2](plan-eng-review-closure.md)。

### NOT_FOUND

HTTP 404。路径或引用的对象不存在（如 `manifests/:id/approve` 的 id）。
修复：先 `GET` 列表确认 id；种子对象见 `packages/database/prisma/seed.ts`。

### UNAUTHORIZED

HTTP 401。身份未通过验证：缺少凭证、凭证过期或签名校验失败。
修复：重新登录取新凭证后重试，不要重试原请求。身份与 `BusinessUser` 的
分离口径见 [ADR-0039](../adr/0039-business-identity-and-unified-authorization.md)，
落地在 T14。

### FORBIDDEN

HTTP 403。身份有效但没有该能力或该资源的权限。与 401 的区别是重登录无用，
需要管理员授予能力或调整资源策略。两阶段授权见
[ADR-0026](../adr/0026-acl-scope-key-and-authoritative-recheck.md)。

### METHOD_NOT_ALLOWED

HTTP 405。路径存在但不接受该 HTTP 方法（如对领域命令端点发 `GET`）。
修复：Manifest 只提供注册与批准两条领域命令，没有通用 `PATCH`；按 OpenAPI
描述改用正确方法。

### PAYLOAD_TOO_LARGE

HTTP 413。请求体或上传文件超过服务端上限。
修复：拆分上传或压缩内容；上限口径随 T4 摄取落地。

### UNSUPPORTED_MEDIA_TYPE

HTTP 415。`Content-Type` 不受支持，或上传文件格式不在解析后端的支持集内。
修复：JSON 端点用 `application/json`；可解析格式见 IngestionManifest 的
`sourceFormats` 与 [ADR-0038](../adr/0038-vlm-parser-backend-and-multimodal-scope.md)。

### CONFLICT

HTTP 409。唯一键冲突且无法按内容寻址幂等返回等价对象。
修复：Manifest 注册按 (tenantId, contentHash) 幂等，重复注册会返回已存在
对象；此错误通常意味着其他唯一键（如 Pipeline 三元组）冲突。

### COMPATIBILITY_VIOLATION

HTTP 422。兼容矩阵校验失败（工程评审闭合记录 §4.3）：向量通道与
Embedding 不一致、Pipeline 组合未批准、Release 与 Ingestion 物理字段
不一致等。修复：按 message 中的违例说明调整 Manifest 引用；Manifest
不可变，字段变化必须新建。

### DEPENDENCY_UNAVAILABLE

HTTP 503。依赖的中间件不可用（如数据库未启动）。
修复：`pnpm run infra:up` 后重试；`/health/ready` 会给出逐项原因。

### RATE_LIMITED

HTTP 429。触发用户级配额（T12 落地）。修复：按 `Retry-After` 退避。

### INTERNAL_ERROR

HTTP 500。未分类异常。响应不含细节；排查用 `trace_id` 查服务日志。
