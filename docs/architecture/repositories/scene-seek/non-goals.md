# `scene-seek` 非目标

当前桌面端不承担以下职责：

- 替代 Web RAG 的企业控制面、Keycloak、租户 ACL 和审计；
- 连接 Web RAG 的 PostgreSQL、OpenSearch、RabbitMQ 或 MinIO 才能运行；
- 在 UI 中直接执行 FFmpeg argv 或供应商 SDK；
- 把所有视频只建模为一个 Document、只做 ASR 或只返回整条视频；
- 用 VLM Caption 替代 shot/scene 级召回；
- 把 SQLite schema 当成跨平台公共契约；
- 创建一个同时承载 Web、桌面和媒体引擎的超级仓库；
- 现在就实现同步 Web 云端媒体处理或独立 Video RAG 服务。

桌面端可以未来提供导入/导出和 Web 同步，但那是版本化互操作能力，不能通过共享数据库或复制权限系统实现。
