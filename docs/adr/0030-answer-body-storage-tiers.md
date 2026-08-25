---
status: accepted
---

# 回答正文与证据摘录不落 PostgreSQL：元数据在 PG、续读窗在 Redis、快照在对象存储

`answer_run_event` 原本按 `run_id + seq` 持久化可展示事件，其 `answer.delta` 与 `evidence.delta` 载荷就是回答正文和原文摘录。这使原文摘录长期驻留在 PostgreSQL，却既不在保留策略表中，也不在删除目标清单中，直接削弱"删除后正文不可恢复"这条硬门禁。本 ADR 按存储职责分层重新划分。

PostgreSQL 的 `answer_run_event` 只保存事件元数据：`runId`、`seq`、`eventId`、`eventType`、`phase`、`occurredAt`、涉及的 `citationId` 与 `documentVersionId` 引用，以及载荷哈希。它不保存正文、摘录和模型原始思考链。`answer_sentence` 与 `citation` 同样只保存句序号、绑定关系、匹配方式、验证状态、位置引用和哈希，不保存摘录文本；界面展示摘录时按当前 ACL 从原文或快照实时取。

Redis 承担 SSE 续读窗口：正文与摘录增量按 `run:{runId}:events` 写入，TTL 24 小时。`Last-Event-ID` 续读时 Redis 命中则从该序号继续推送；Redis 已过期或丢失则不拼接正文，直接返回最终快照，界面据此整体渲染而不是增量追加。这一降级路径必须有明确的用户提示和测试覆盖。

对象存储承担长期快照：`AnswerRun` 完成时把最终正文、逐句引用和证据摘录写为不可变快照对象，沿用现有 Evidence/ReplayBundle 的受控等级与 AnswerRun 完成后 90 天保留期。快照对象是唯一的长期正文副本。

删除因此简化为单点：文档删除或合规清理时，删除目标只需覆盖对象存储快照与 Redis 前缀，PostgreSQL 侧无正文需要清理，只写墓碑并保留哈希、版本、指标用于影响分析。Replay 等级判定沿用 `FULL` / `METADATA_ONLY` / `EXPIRED`：快照在保留期内为 `FULL`，快照已清理但元数据在为 `METADATA_ONLY`，元数据也过期为 `EXPIRED`。
