# `scene-core` 引擎调用协议

> 这是跨 Web RAG 与 scene-seek 的候选协议设计，不表示引擎已经实现。协议稳定后应在引擎仓库中补充 JSON Schema、CLI 帮助和兼容矩阵。

## 1. 传输

初期采用 JSON/JSONL：

- 一条请求进入 stdin 或等价的受控进程通道；
- 事件逐条输出到 stdout；
- 媒体/Artifact 字节不内嵌 JSON；由调用方提供受控输入和输出 staging；
- stderr 只供受控诊断，不作为稳定协议；
- HTTP/gRPC 不属于 MVP 前置依赖。

## 2. 请求 Envelope

请求必须额外携带 executionContext：

```
runId
generation
attempt
scope: asset | query | evaluation
```

引擎只接受调用方创建的受控 staging handle、文件描述符或流引用。任意主机路径不能进入持久化领域记录；引擎不自行推断业务权限或当前索引代次。

候选字段如下：

```json
{
  "protocolVersion": "1.0",
  "requestId": "req_01",
  "operation": "probe",
  "sourceVersionId": "assetv_01",
  "input": {
    "kind": "host_path_or_stream",
    "ref": "opaque-to-domain"
  },
  "inputFingerprint": "sha256:...",
  "options": {},
  "deadlineMs": 120000,
  "cancellation": {"token": "opaque"}
}
```

约束：

- `requestId` 在调用方作用域唯一；
- `sourceVersionId` 用于结果关联，不代表引擎负责权限；
- `input.ref` 只在进程调用边界有效，不得写入公共领域记录；
- `operation` 只能取已发布的能力，不接受任意 FFmpeg argv；
- `deadlineMs`、取消和资源选项必须有上限，不能由不可信用户直接扩大。

## 3. 事件 Envelope

```json
{
  "protocolVersion": "1.0",
  "requestId": "req_01",
  "sequence": 3,
  "eventType": "completed",
  "status": "succeeded",
  "progress": {"completed": 1, "total": 1},
  "sourceVersionId": "assetv_01",
  "outputFingerprint": "sha256:...",
  "artifactManifest": {},
  "resourceUsage": {},
  "occurredAt": "2026-09-04T00:00:00Z"
}
```

允许的事件类型至少包括：`accepted`、`progress`、`artifact_ready`、`completed`、`failed`、`cancelled`、`timed_out`。事件通过 `requestId + sequence` 去重和恢复；序号不得回退。

## 4. Artifact Manifest

```json
{
  "manifestVersion": "1.0",
  "sourceVersionId": "assetv_01",
  "engineVersion": "0.1.0",
  "engineCommit": "sha256:...",
  "artifacts": [
    {
      "artifactId": "artifact_01",
      "kind": "keyframe",
      "mediaType": "image/jpeg",
      "ref": "relative-or-stream-ref",
      "byteSize": 123456,
      "contentHash": "sha256:...",
      "startMs": 12000,
      "endMs": 12001,
      "createdByRequestId": "req_01"
    }
  ]
}
```

Manifest 只描述引擎产出，不承担存储归属。`ref` 不是公共 URL、对象键或永久路径。Artifact 保存后由调用方替换为自己的存储引用。

适用时间区间必须满足：

```text
startMs >= 0
endMs > startMs
```

单帧可以用 `frame`/`frameIndex` 描述；不要为了满足时间字段伪造不可验证的区间。

## 5. 错误

稳定错误至少区分：

```text
INVALID_REQUEST
UNSUPPORTED_INPUT
CORRUPT_MEDIA
MISSING_STREAM
RESOURCE_LIMIT
TIMEOUT
CANCELLED
ENGINE_INTERNAL
```

错误输出只带 `code`、可安全展示的 `message`、`retryable` 和受控 details。FFmpeg 原始命令、完整 stderr、主机绝对路径和敏感输入不进入公共错误。

## 6. 取消、超时和部分产物

Artifact 先处于 staged 状态，只有 Manifest 校验、Hash 校验和调用方确认完成后才能 finalize 为 complete。失败或取消的产物标记为 failed/partial 并隔离清理，不能直接驱动 Evidence 或索引。

- 取消由调用方发出，业务 Run 是否 `cancelled` 由调用方事实源决定；
- 引擎必须尽快停止当前操作，并返回 `cancelled`，不能返回 `succeeded`；
- 超时返回 `timed_out`，调用方决定是否新建 attempt/retry；
- 部分 Artifact 必须明确标记为临时/不完整，不能被调用方直接发布为正式 Evidence；
- 进程重启后，调用方通过新的 request/run 恢复，不依赖引擎内存状态。

## 7. 资源统计

每次完成、失败或取消的请求尽量返回：

```text
wallTimeMs
cpuTimeMs
peakRssBytes
inputBytes
outputBytes
hardwareAcceleration（若可验证）
```

资源指标用于 readiness gate 和平台报告，不作为跨平台相等的性能承诺。

## 8. 兼容策略

- 破坏性请求/事件/Manifest 变化：协议 major 递增；
- 新增可选字段：minor 递增并保持旧消费者可忽略；
- 引擎实现修复：patch 递增；
- 消费者固定 `engineProtocolVersion + engineVersion + engineCommit`；
- Web 和桌面必须运行同一组协议 fixture，Rust library 与 CLI 输出不得无故漂移。
