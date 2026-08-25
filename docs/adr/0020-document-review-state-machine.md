---
status: accepted
---

# 文档采用四态审核状态机

文档业务审核状态采用 `Draft -> PendingReview -> Published -> Archived` 四态。`submit-review` 将 Draft 送审；审核通过后才能 Published；驳回回到 Draft 并保留审核意见；Published 只能通过显式归档进入 Archived。编辑已发布文档生成新的不可变版本，不直接改写正在服务的版本。

审核状态与解析、索引、图谱抽取等处理状态正交保存。每次审核动作写入审核历史，包括操作者、意见、时间、来源版本和前后状态。Draft/PendingReview 可以预构建隔离的候选索引，但工作台只能检索已发布、在有效期内且对应 Release 已激活的文档版本；`Archived`、未通过审核、未激活或处理未完成的版本不得进入默认检索范围。
