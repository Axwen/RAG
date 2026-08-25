---
status: accepted
supersedes: 0015-aliyun-oss-and-resource-aware-compose.md
---

# MVP 默认使用本地 MinIO，阿里云 OSS 延后

开发主机为 32 GiB 内存；WSL2 日常上限建议设为 22 GiB，执行 DeepDOC 或批量评测时可临时提高到 24 GiB。MinIO 作为本地 Docker Compose 默认对象存储。MVP 的原文件、解析产物、图片和引用快照先写入 MinIO，避免日常开发依赖云端凭证、网络和费用；MinIO 使用持久化 Docker volume，不把对象内容写入 Git 或应用源码目录。

当前 MVP 不部署阿里云 OSS，也不创建 OSS Bucket 或配置云端凭证。阿里云 OSS 仅作为未来云端部署的可选实现。NestJS 通过 `ObjectStorageAdapter` 屏蔽 MinIO 与 OSS 的差异，统一提供预签名上传、下载、对象存在性、哈希/大小校验和删除能力。Adapter 必须使用契约测试验证两种实现，不把 MinIO 特有行为泄漏到业务模块。

MinIO 单节点开发实例建议设置 512 MiB～1 GiB 内存上限；在本项目的几十份文档和小规模评测下，MinIO 通常只占数百 MiB。22 GiB 足以运行 PostgreSQL、Redis、Keycloak、单节点 OpenSearch、MinIO、Next.js、NestJS 和 Worker；24 GiB 可为 DeepDOC Parser 或批量评测提供额外余量。完整观测栈和压测任务仍通过独立 Compose Profile 按需启动。该配置不用于本地大模型或生产容量压测。
