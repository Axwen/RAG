# `scene-core` 实施路线

## M0：仓库与协议骨架

- 创建 Rust workspace；
- 固定 MSRV、构建目标和版本策略；
- 实现 JSON/JSONL Envelope 的解析、校验和事件序号；
- 建立无真实用户媒体的合成 fixture；
- 输出协议 Schema、CLI help 和错误码表。

验收：协议测试能覆盖非法请求、事件乱序/重复和受控错误；不需要连接数据库或 Provider。

## M1：媒体探测与基础 Artifact

- probe 容器、音视频流和基础元数据；
- 音频抽取；
- 封面、关键帧和基础帧抽取；
- Hash/Fingerprint 和 Manifest；
- 取消、超时、进度和资源统计；
- 临时 Artifact 清理。

验收：真实脱敏/公开测试媒体覆盖无音轨、无视频轨、损坏媒体、可变帧率和大文件边界；结果通过 `sourceVersionId` 和 request/run 关联。

## M2：可靠性和资源基线

- 进程崩溃、磁盘不足、超时和取消恢复；
- CPU/内存/磁盘基准；
- 受控错误和重试分类；
- CLI 与 library 输出一致性；
- Web/Desktop 调用方兼容矩阵。

验收：异常不会伪报完成，部分产物不会污染索引；建立 P50/P95 和资源报告。

## M3：分层切分（后续）

- shot/scene segmentation；
- segmentationRef/shotPolicyRef 版本化；
- 时间边界和相邻关系；
- 与 Evidence Asset → Scene/Shot → Evidence 的映射 fixture。

验收：需要真实媒体黄金集、人工时间标注、Temporal IoU 和资源基线；没有这些证据不冻结算法参数。

## M4：可选服务化（不预设）

只有 Web 和桌面两个稳定消费者出现真实吞吐/隔离问题后，才评估 Worker Pool 或独立服务。服务化只能替换 Adapter 和部署，不改变引擎协议和 Manifest 语义。
