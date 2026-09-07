# Web RAG 媒体引擎接入方式

## 1. 调用原则

媒体能力属于异步入库或受控修复任务，不属于浏览器直连能力。推荐链路：

```text
浏览器上传媒体
      │
      ▼
Node API：鉴权、限流、创建 AssetVersion
      │
      ▼
PostgreSQL 任务事实 + RabbitMQ 投递
      │
      ▼
Web Worker：认领 Run、准备输入、执行 MediaEngineAdapter
      │
      ├── scene-core probe/extract/frame
      │       └── JSON/JSONL 事件 + Artifact Manifest
      │
      ├── object storage adapter 保存原始媒体和 Artifact
      ├── AI Adapter 执行 ASR/OCR/Embedding 等后续任务
      └── Evidence/Index/Release 事务和写回门禁
```

浏览器只调用 Web API，不知道 FFmpeg argv、引擎临时目录、供应商 SDK 或对象存储连接。

## 2. 输入、输出和保存责任

| 内容 | Media Engine | Web RAG |
|---|---|---|
| 读取媒体字节 | 在调用方提供的受控输入中读取 | 负责授权、下载/暂存和清理 |
| Probe/抽取/帧处理 | 负责 | 负责调度和接收结果 |
| Artifact Manifest | 生成并校验 Hash/时间元数据 | 注册版本、保存 Artifact、关联 Run |
| 原始媒体和 Artifact 持久化 | 不负责 | object storage adapter |
| Evidence/Provenance | 提供处理元数据 | 生成领域 Evidence 和 Provenance |
| ACL、删除、过期、Legal Hold | 不负责 | PostgreSQL/业务授权事实 |
| OpenSearch 投影和 Release | 不负责 | 负责 |
| ASR/OCR/Embedding/Rerank | 不负责 | 服务端 AI Adapter |

引擎返回的 `relativeRef` 或临时文件引用只在本次调用边界内有效。Web 保存后使用自己的对象键和 Artifact metadata，不能把本地绝对路径当成长期领域字段。

## 3. 初始调用形态

第一阶段采用受控进程调用：

- Web Worker 启动固定版本的 CLI/Worker binary；
- 输入和输出使用 worker 私有 staging 目录或受控流；
- JSON/JSONL 传递请求、进度、Manifest 和错误；
- Node 侧以 `requestId + sequence` 接收事件并做幂等处理；
- 任务取消同时更新 Web Run 状态并向进程发送取消信号；
- 进程完成后，Web 仍须检查 `sourceVersionId`、`generation`、`inputFingerprint`、`runId` 和 `attempt`。

如果未来改成引擎 Worker Pool 或独立服务，变化只应落在 `MediaEngineAdapter` 和部署配置，不改变 Evidence、Artifact Manifest、ProviderRun 或 Citation 语义。

## 4. 失败和恢复

| 场景 | Web 行为 | 引擎行为 |
|---|---|---|
| 输入文件消失 | Run 失败并保留受控错误 | 返回不可重试输入错误 |
| 引擎崩溃 | 记录 attempt 失败，按策略重试/隔离 | 不伪报完成；清理可识别临时产物 |
| Web Worker 重启 | 由 PG/RabbitMQ 恢复任务并重新校验 | 新调用使用新的 attempt 或 run |
| 用户取消 | 将业务 Run 标为 cancelled，拒绝迟到结果 | 尽快终止子进程并发出 cancelled 事件 |
| 新版本覆盖旧版本 | 增加 generation | 旧调用可完成，但结果禁止写回 |
| 部分 Artifact 已生成 | 作为临时或历史 Artifact 隔离 | Manifest 标识完成/部分失败，不宣称整体成功 |

## 5. 查询时的特殊调用

普通 lexical/dense/rerank 查询不需要重新调用媒体引擎，直接使用已经入库的 Evidence、索引和 Citation。以下动作才可触发媒体引擎：

- 用户引用跳转时，已有预览 Artifact 缺失，需要补抽帧；
- 重新生成某个时间区间的 thumbnail/keyframe；
- 对已验证的 AssetVersion 执行受控修复或重新探测。

这些动作必须是独立 Run，不得在查询请求里隐式启动不可恢复的长任务。

## 6. 当前不实现

本文件只定义接入方式，当前不实现：真实媒体导入、FFmpeg/FFprobe、ASR、OCR、视觉 Embedding、Caption、视频 Worker、Web 视频 UI 或独立服务。真实实现必须先通过 [Video RAG readiness gate](../../../engineering/video-rag-readiness-gate.md)。
