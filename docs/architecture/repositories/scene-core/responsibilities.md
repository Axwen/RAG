# `scene-core` 职责说明

## 1. 输入

引擎接受调用方提供的受控媒体输入和操作选项：

- Asset/AssetVersion 的关联身份；
- 调用方计算或要求引擎计算的 input fingerprint；
- host-owned 的输入流或临时文件引用；
- 操作类型和资源/超时/取消约束；
- 可选的抽取范围和采样策略。

输入引用只在调用边界有效。引擎不能自行访问云对象存储、用户目录之外的路径或数据库。

## 2. 处理职责

### 第一阶段 MVP

- probe 容器、流、编码、时长、帧率、音轨/视频轨和基础元数据；
- 归一化非负毫秒时间和可用的媒体时间基；
- 抽取音频、封面、关键帧和基础帧；
- 计算内容 Hash/Fingerprint；
- 生成 Artifact Manifest；
- 发送单调进度、受控错误、取消/超时结果和资源统计。

### 后续阶段

- 更稳定的可变帧率和损坏时间戳处理；
- 可配置的 shot/scene segmentation；
- 针对不同硬件的资源策略和批量处理；
- 在 readiness gate 通过后支持更多媒体输入边界。

shot/scene 不是 MVP 的默认隐式能力。没有稳定评测和版本化策略时，不能把任意帧列表描述成 Scene/Shot。

## 3. 输出职责

引擎输出：

```text
EngineResponse
  ├── normalized media metadata
  ├── input/output fingerprint
  ├── ArtifactManifest
  ├── progress/final status
  ├── resource measurements
  └── controlled error (if failed)
```

引擎不输出业务 ACL、KnowledgeSpace、Release、Evidence 可见性或回答 Citation。调用方负责把 Manifest 映射成公共 ProviderArtifact/Evidence。

## 4. 质量要求

- 对同一输入和同一版本配置，元数据和 Manifest 的排序/字段输出应确定性；
- 不把 FFmpeg 原始 stderr 直接作为用户错误；
- 不在成功响应中隐藏部分失败或缺失轨道；
- 取消后不伪报成功，已生成的临时 Artifact 可被调用方隔离清理；
- 所有时间区间满足公共 `startMs >= 0`、`endMs > startMs`；
- 输出能关联 `sourceVersionId`、run/request 和 engine protocol/version。
