# PROBE-002 DeepDOC Parser 探针结果

- 状态：**PASS**
- 执行时间：2026-08-26T10:47:32Z
- Parser 版本：ragflow-deepdoc@618c4599/v0.27.0
- Tokenizer 模式：`infinity`
- 模型：{'layout.onnx': True, 'tsr.onnx': True, 'det.onnx': True, 'rec.onnx': True, 'updown_concat_xgb.model': True}
- 宿主 Docker Engine 可见内存：23.47 GiB（来自 PROBE-000；低于建议 24 GiB profile，因此资源结论按 `PASS_WITH_ADJUSTMENT` 边界解释）

> LIVE = DeepDOC 真实解析事实；SIMULATED = Parser Service 服务层协议（parserTaskId 生命周期/幂等注册/超时取消崩溃恢复），在 Worker/Parser 集成测试阶段复测。合成数据，无真实客户信息。

## 每样本产物（LIVE）

| 样本 | HTTP | 类型 | 契约完整 | 块数 | 已定位 | 定位率 | 表格数 | 解析秒 | 峰值RSS(MiB) |
|---|---|---|---|---|---|---|---|---|---|
| markdown | 200 | markdown | 是 | 11 | N/A | None | 1 | 0.001 | 299.4 |
| native_single.pdf | 200 | pdf | 是 | 7 | 7 | 1.0 | 0 | 2.732 | 874.3 |
| double_column.pdf | 200 | pdf | 是 | 20 | 20 | 1.0 | 0 | 1.165 | 949.2 |
| cross_page_table.pdf | 200 | pdf | 是 | 1 | 1 | 1.0 | 1 | 5.121 | 993.1 |
| scanned.pdf | 200 | pdf | 是 | 7 | 7 | 1.0 | 0 | 1.998 | 1111.7 |

## 协议校验

```json
{
  "idempotency": {
    "same_content_hash": true,
    "same_block_count": true,
    "same_layout_sequence": true,
    "note": "DeepDOC determinism verified LIVE; tenant+hash+version registry dedup is service-layer, SIMULATED."
  },
  "no_half_artifact": {
    "clean_failure": true,
    "http_status": 500,
    "note": "malformed PDF rejected with no artifact (expected)"
  },
  "lifecycle_simulated": {
    "states": [
      "QUEUED",
      "RUNNING",
      "COMPLETED",
      "FAILED",
      "CANCELED"
    ],
    "note": "parserTaskId lifecycle is owned by the Parser Service + PostgreSQL (ADR-0014), not by DeepDOC. The throwaway wrapper parses synchronously, so lifecycle/cancel/crash-recovery are SIMULATED here and MUST be re-verified at Parser-Service integration test time. DeepDOC itself is proven side-effect-free: a failed parse returns HTTP 500 with no artifact, i.e. no half-Artifact is emitted (verified LIVE via the malformed-input probe below)."
  }
}
```
