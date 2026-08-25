---
status: accepted
---

# 开发使用 Compose，试点使用私有 Kubernetes

本地开发用 Docker Compose 降低启动成本，真实用户试点部署在企业私有 Kubernetes 中，以隔离在线 API、文档解析、模型执行区和数据服务，并提供 Secret、配额、扩缩容和故障恢复能力。敏感资料只能进入私有环境中的本地模型执行区，不能因本地模型故障自动降级到云模型。
