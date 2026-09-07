# Video RAG 三仓库规划包

> 状态：规划已确认，职责资料已于 2026-09-05 迁移至 `scene-core` 独立目录与既存的 `scene-seek` 仓库；当前目录位于 Web RAG 仓库中，继续保存总规划、公共契约事实源和跨仓库约束。
>
> 当前分支：`docs/video-rag-foundation`

## 1. 目的

本目录回答一个边界问题：Web RAG 的知识库未来可以包含 Video/Audio，但 Web 服务、Rust 媒体处理和本地桌面工作台是否应该共享同一个运行时。

结论是：

```text
共享：语义协议、版本语义、纯逻辑、测试向量、评测格式
不共享：数据库、消息队列、对象存储、文件布局、部署拓扑、Provider 进程
```

目标不是把 Web RAG 拆成微服务，而是让 Web RAG、scene-core 和 scene-seek 按一套可执行的跨仓库边界推进。

## 2. 三个仓库

| 规划仓库 | 当前资料 | 职责 | 当前状态 |
|---|---|---|---|
| Web RAG | [web-rag/](web-rag/README.md) | Web UI、Node 控制面/Worker、企业存储和治理、公共契约、`rag-core` | 当前仓库，继续开发文档 RAG |
| `scene-core` | [scene-core/](scene-core/README.md) | Rust 媒体核心、FFmpeg/FFprobe 调用、媒体 Artifact 和资源控制 | 规划资料已落到独立目录，git 尚未初始化 |
| `scene-seek` | [scene-seek/](scene-seek/README.md) | Video RAG 工作台、本地 SQLite/Artifact/Worker、时间线和本地 AI Adapter | 既存仓库，规划资料已增量迁移，当前无提交 |

当前不创建第四个 `rag-foundation` 或 `ai-runtime` 仓库。

## 3. 阅读顺序

1. [ADR-0045：共享 Rust Media Engine 与三仓库边界](../../adr/0045-shared-media-engine-and-three-repository-boundary.md)
2. [跨仓库公共契约](cross-repository-contracts.md)
3. [Web RAG 规划包](web-rag/README.md)
4. [scene-core 媒体核心规划包](scene-core/README.md)
5. [scene-seek Video RAG 规划包](scene-seek/README.md)
6. [T17：Video RAG 公共基座](../../engineering/tickets/T17-video-rag-public-foundation.md)
7. [Video RAG 公共契约 Spec](../../engineering/video-rag-public-contract-spec.md)
8. [Video RAG 公共基座实施任务](../../engineering/video-rag-implementation-tasks.md)
9. [Video RAG readiness gate](../../engineering/video-rag-readiness-gate.md)

## 4. 迁移记录

2026-09-05 已按职责完成一次增量迁移。目标仓库均保留原有内容；迁移只新增架构资料和公共协议快照，不复制 `.data/`、原始媒体、真实数据库、转写正文、凭据或模型权重。

| 当前目录 | 复制目标 | 复制规则 |
|---|---|---|
| `scene-core/` | `scene-core` 仓库的 `docs/architecture/repositories/scene-core/` | 增量复制媒体核心职责、引擎契约、MVP 范围、路线和非目标；实现后补充版本发布记录 |
| `scene-seek/` | `scene-seek` 仓库的 `docs/architecture/repositories/scene-seek/` | 增量复制 Video RAG 本地运行时、职责、路线和非目标；与既有逆向资料并存，实现后补充兼容矩阵 |
| `cross-repository-contracts.md` | 两个目标仓库同路径 `docs/architecture/repositories/cross-repository-contracts.md` | 复制公共协议快照；当前 Web RAG 的 `packages/contracts`/`packages/rag-core` 仍是语义事实源，目标仓库不得悄悄修改语义 |
| `web-rag/` | 当前仓库继续保留 | 它是当前 Web RAG 的边界说明，不需要再创建同名 Web 仓库 |

迁移后的协议修改必须先更新当前 Web RAG 的公共契约事实源，再同步两个目标仓库的快照、引擎协议实现和兼容矩阵；不能只改某一个仓库的本地说明。

## 5. 当前明确不做

- 不创建独立 `video-rag-service`；
- 不把 Rust、FFmpeg、Tauri、SQLite 或本地 Worker 引入当前 Web RAG 的公共核心；
- 不在当前仓库接入真实媒体、真实转写、真实供应商或用户密钥；
- 不把 Seelyn 参考资料写成已实现事实；
- 不把三仓库计划描述成已经完成的 Video RAG 运行时。
