# `scene-seek` 实施路线

## D0：桌面运行时骨架

- Tauri 窗口、应用状态和本地配置；
- SQLite WAL 与本地 Artifact Store 的最小 schema；
- Worker Supervisor、事件游标和恢复模型；
- 固定版本 media engine 的探针调用；
- 本地资源采集和日志脱敏。

验收：可以导入脱敏/公开测试媒体，异常退出后不丢失 Run 状态，也不把旧结果写入当前索引。

## D1：媒体边界和时间线

- Asset/AssetVersion；
- probe、音频、封面、关键帧和基础帧；
- Artifact Manifest；
- 时间线播放器和 Citation 跳转；
- 缺失 Artifact、取消、超时和清理。

验收：G0 readiness gate 通过，时间区间和 Artifact Hash 可验证。

## D2：文本时间证据

- 字幕导入；
- 本地/受控 ASR Adapter；
- speech/subtitle Evidence；
- FTS 查询、片段级定位、Recall/MRR/Temporal IoU；
- 断点恢复和失败重试。

验收：G1 通过，不能只返回整条视频。

## D3：视觉检索

- shot/scene 分层；
- OCR 与 image-region；
- 视觉 Embedding Channel；
- 文字搜画面、图片搜画面、融合、去重、时间邻接和 diversity。

验收：G2 通过，视觉 channel 与文本 channel 可解释且不混写。

## D4：可信工作台

- Rerank、Caption/VLM 可选增强；
- Grounded Answer、句级 Citation 和冲突/注入处理；
- 评测数据集、资源基准、Provider 对比和 hard negative；
- 导出/导入公共证据和 Artifact Manifest（如确有需求）。

验收：G3/G4 通过后，才讨论 Web 互操作和服务化。
