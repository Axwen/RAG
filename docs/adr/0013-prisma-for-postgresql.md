---
status: accepted
---

# 使用 Prisma 管理 PostgreSQL

TypeScript 后端使用 Prisma 和 Prisma Migrate 管理 PostgreSQL 关系模型、事务和常规查询，以匹配当前开发者经验并减少数据访问样板。Prisma 只负责 PostgreSQL，不抽象 OpenSearch、Redis 或 MinIO；数据库扩展、部分索引、表达式索引、触发器和少量复杂查询通过自定义 SQL migration 或受控 raw query 实现，不再并行引入第二套 ORM。HTTP、队列和模型输入仍通过 Zod 校验，Prisma 生成类型不是系统外部契约。
