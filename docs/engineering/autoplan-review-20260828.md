# /autoplan 评审报告（2026-08-28）

- **评审对象**: 现有架构（PROJECT_STATE + 阶段1 Tickets + T0 DX Review + Probe Decision Gate + 工程评审闭合记录）
- **性质**: CEO + 技术先进性双轴评审（UI/Eng/DX 阶段对 T0 已完成项目意义不大，跳过）
- **项目性质澄清**: 个人学习练手项目，目标是技术完整性和企业级架构学习，不是商业交付
- **双 Voice**: Codex（战略挑战）+ Claude subagent（深度技术审计），均已完成

## 前提门裁决

用户澄清：这是个人学习项目，商业验证类发现作废，保留纯技术和先进性维度。

## 仍成立的技术发现

| # | 发现 | 严重度 | 行动 | 票据影响 |
|---|---|---|---|---|
| T1 | 1024 vs 4096 维在真实中文专业语料上未对照 | **Critical** | T6 增加同语料对照实验 | T6/T9 |
| T2 | fluxionai 合规/身份未决 | **Critical** | T15 前设 2 周截止日，备选 OpenRouter Chat | T15 |
| T3 | PROBE-006 的 6 题无统计效力 | **High** | 50 题+5 份长文档出来前不宣布检索闭合 | T9 |
| T4 | parent-child 被关闭但长文档跨节召回未验证 | **High** | T9 黄金集至少含 5 份 >20 页文档 | T9 |
| T5 | 24-36 周系数未校准 | **Medium** | 前 3-4 票据交付后用实际速率重校准 | 全局 |
| T6 | ModelAdapter 方言层可能过度特化 | **Medium** | T15 ADR 约束方言层 <150 行 | T15 |

## 技术先进性站位

| 维度 | 当前 | 2026 前沿 | 差距 | 阶段1 行动 |
|---|---|---|---|---|
| Embedding | MRL 1024 | Matryoshka + ColBERT | 中 | 保持，T9 做 1024/4096 对照 |
| Rerank | 交叉编码器 Top-5 | LLM rerank / listwise | 小 | 保持 |
| Chunking | wide-1024 固定窗口 | 语义分块 / late chunking | 中 | 固定窗口做基线，T9 A/B 语义分块 |
| 检索 | BM25+vector hybrid | ColBERT / graph RAG / agentic RAG | 中 | hybrid 是 2026 企业标配；agentic RAG 留阶段2 |
| 引用验证 | 逐句Embedding+蕴含校验 | grounded generation | 小 | 自建方案中已是领先水平 |
| **多模态** | **仅PDF文本** | **VLM直接理解图像/表格** | **大** | **最大缺口；T4 预留 VLM Parser 共存** |
| 索引 | OpenSearch BM25+vector | neural sparse (SPLADE) | 小 | T5 可探索 |
| 状态机 | 正交状态+CAS | event-sourcing+CQRS | 中 | 阶段2 方向 |
| 部署 | Docker Compose | K8s+GitOps+Knative | 大 | 阶段1 合理；阶段2 上K8s |

### 三个最值得关注的先进性方向

1. **Late/Contextual Chunking**（2026 下半年热点）— T9 evals 中做对比
2. **Agentic RAG / Multi-step Retrieval**（2027 方向）— Worker profile 已预留多步编排能力
3. **VLM 直接解析**（消除 Parser 管线）— Parser Adapter 层已预留，T4 可让 VLM 与 DeepDOC 共存

## 商业类发现（已作废，记录备查）

以下因项目性质（学习练手）而作废，不纳入行动项：
- "无客户/付费意愿验证"、"共享基座 YAGNI"、"信任≠付费理由"、"84.5人日过重"
- "先做 SaaS POC"、"单租户先上"、"6 中间件过重(学习运维本身就是价值)"
- "治理差异化不是购买驱动力"、"运维TCO对比"

## 结论

架构的工程纪律和协议闭合度在自建 RAG 领域是上乘水平。6 项纯技术发现中 2 项 Critical（维度对照 + 供应商合规）应在对应票据开工前关闭。多模态是最大的先进性缺口，T4 的 Parser Adapter 层应显式预留 VLM 路径。阶段 1 的技术选型整体处于 2026 企业 RAG 主流线上，agentic RAG 和 event-sourcing 是阶段 2 的自然进化方向。
