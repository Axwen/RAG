---
status: accepted
date: 2026-08-28
decision-basis: /autoplan 技术先进性评审（多模态为最大缺口）与用户两轮裁决：多模态纳入阶段 1，但解析全链路不新增云模型，图片走本地 DeepDOC OCR
---

# 阶段 1 多模态解析范围重定（DeepDOC OCR 与 Office 库提取；VLM 后置）

## 决策

Parser Service（ADR-0014）从单后端扩展为**多后端架构**，统一收敛在既有 `ParseInput -> ParseArtifact` 契约之后；NestJS 与 Worker 不感知后端差异。**阶段 1 解析全链路不引入任何新的云模型调用**。格式路由：

| 输入格式 | 解析路径 | 定位精度 |
|---|---|---|
| Markdown、JSON/CSV | 直读文本，不进解析后端 | 行/记录级 |
| 原生 PDF、扫描 PDF | DeepDOC 后端（不变） | 页 + bbox |
| JPG/PNG 图片 | **DeepDOC OCR 后端**：本地 OCR 直接跑图片 | 图内 bbox |
| DOCX/PPTX/XLSX | **混合后端**：格式专用库提取文本与结构，内嵌图片提取后走同一 DeepDOC OCR | 结构位置 + bbox |
| 其他（.doc/.ppt/.xls 旧二进制、WPS 等） | **显式拒绝 + 审计入口**，不静默误解析，不引入 tika 兜底 | — |

```text
上传(MD/JSON/CSV/PDF/图片/Office)
        │
        ▼
  ┌─ 格式路由表(配置驱动)────────────────────────────┐
  │ MD/JSON/CSV ──► 直读文本                          │
  │ PDF ─────────► deepdoc 后端(页+bbox)              │
  │ JPG/PNG ─────► image_ocr 后端(本地 OCR, 图内 bbox) │
  │ DOCX/PPTX/XLSX ► office_hybrid 后端               │
  │     ├─ 文本/结构: 移植的精简 parser(参考 ragflow)  │
  │     └─ 内嵌图片: blob 提取 ──► 同一本地 OCR 入口    │
  │ 未列出格式 ───► 显式拒绝 + 审计入口(fail-closed)    │
  └───────────────────────────────────────────────────┘
        │  所有格式共用 T4a 异步任务协议(上传→队列→Worker 认领
        │  →解析→回写),无同步例外,取消/重试/孤儿清扫统一复用
        ▼
  ParseArtifact(块列表 + bbox/结构位置 + 后端标识 + 质量告警)
        │
        ▼
  T13 注入检测(所有后端输出同一检测链) ──► 分块/索引
```

- **图片理解的默认答案是本地 OCR，不是 VLM。** 依据是参考实现 RAGFlow 自身的管线（`rag/app/picture.py`）：本地 DeepDOC OCR 为主（`_get_ocr()(np.array(img))`），CV/视觉 LLM 只是可选增强层、不可用时降级为只索引 OCR 文本。`deepdoc/parser/` 自带 `docx_parser.py`、`ppt_parser.py`、`excel_parser.py`，docx 解析器已内嵌图片 blob 提取，是混合后端的直接参考。
- **不直接依赖 ragflow 工程代码。** 其 parser 依赖 `rag.utils`、`LLMBundle`、tenant 模型服务等工程内模块；混合后端的 Office 解析器按参考实现自行移植精简版，`references/` 目录保持仅作参考。与 DeepDOC 本体冻结 vendored 的既有做法一致。
- **所有格式共用 T4a 异步任务协议，无同步例外。** 图片解析虽快，也不引入同步快路径——同步接口无法恢复长任务、跨库部分失败不可逆，正是 T4a 要关闭的坑。
- **未列出格式显式拒绝**（fail-closed + 审计入口），不静默误解析（ADR-0021 禁止把解析错误变成可回答事实），不引入 tika 等 JVM 兜底依赖。
- **VLM 不进阶段 1。** 视觉语言模型作为阶段 2 的可选增强槽位保留（对 OCR 搞不定的纯图表/流程图做语义描述），参考 `figure_parser.py` 的"OCR 文本 + 图像发给视觉模型"模式；启用前必须有自己的探针证明相对 OCR-only 的检索增量。音频（ASR）与视频同样后置：不同模型类别，复用同一后端槽位。
- **OCR 输出即 bbox**：图片与内嵌图走 DeepDOC OCR 后定位精度仍是 bbox，与 PDF 主链一致；`ParseArtifact` 只需声明后端标识，无需为图片引入 `page` 级降级。
- **不可信内容处理不变**（ADR-0032）：OCR 提取的图片内嵌指令注入与表格/OCR 文本注入是同等威胁，图片产出进入与 PDF 输出相同的注入检测链。
- **成本口径**：解析阶段云调用成本为零（全部本地）。内存是唯一资源约束——图片 OCR 复用 PROBE-002 已验证的 DeepDOC 资源画像，Office 提取为纯 CPU 轻量库。

## 依据

原始功能报告的设计包含完整多模态；阶段 1 工程评审曾将其整体后置。2026-08-28 /autoplan 评审确认多模态是最大先进性缺口，用户裁决将其纳入阶段 1；随后用户进一步裁决：个人学习项目没有必要为此引入新的云模型——OCR 对带文字图片（客服文档的主体）已经足够，VLM 的按页成本不划算。本 ADR 是两轮裁决的合成：**多模态进阶段 1，VLM 不进**。

技术依据：DeepDOC 的 OCR（`deepdoc/vision/ocr.py`）接受任意图像输入而非仅 PDF 渲染页，且已在 PROBE-002 扫描件路径上验证过中文质量；《PPTX 文件解析为 md 文档》教程与 ADR-0021 的路线（格式专用库 → 统一 Markdown/AST）覆盖 Office 文本，两者都不需要云模型。

## 影响与后续

1. **T4 拆为 T4a/T4b**：T4a 为原范围（DeepDOC 后端 + 两阶段对象认领 + 异步任务协议），其 `ParseArtifact` 契约**一次定形**——包含可选的后端标识枚举（默认 `deepdoc`）与格式路由表接口，T4b 只做增量实现（新后端、路由表填充），不再改契约。T4b 不阻塞 T4a。
2. **PROBE-007 改为本地探针**：验证 DeepDOC OCR 直接跑独立图片（截图/图表/照片）与 Office 内嵌图片提取的中文质量，以及 docx/pptx/xlsx 库提取的结构还原度——零云成本，一次本地运行。
3. 契约落点：`packages/contracts/src/parser/` 的 `ParseArtifact` 增加后端标识；格式路由表进 Parser Service 配置而非硬编码。
4. 配置落点：`.env.example` 不新增任何云模型变量；图片/Office 解析只有本地资源边界（复用现有 `PARSER_MEMORY_LIMIT` 等）。
5. 视觉嵌入与以图搜图（多模态向量检索）不在本 ADR 范围，属阶段 2；VLM 增强槽位同属阶段 2。
6. Docling 是否作为 Office 文本提取的替代实现，维持原挂起状态（待格式构成抽样）；若引入，它只是混合后端中"文本提取"一栏的替换件。

## GSTACK REVIEW REPORT

评审日期 2026-08-28，/gstack-plan-eng-review(FULL_REVIEW),评审对象为本 ADR + PROBE-007 票据 + T4a/T4b 拆分。

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 8 issues, 全部当场决议并落文档 (D1-D8);0 critical gaps |
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 (2026-08-28, /autoplan) | CLEAR | 见 autoplan-review-20260828.md,前提门已裁决 |
| Codex Review | — | Independent 2nd opinion | 0 | [outside-voice-unavailable] | 分类器故障,降级记录 |
| Design Review | — | UI/UX gaps | 0 | — | 无 UI 范围,不适用 |
| DX Review | — | Developer experience | 1 (2026-08-28, T0) | CLEAR | 见 t0-dx-review-20260828.md |

决议摘要(全部已写入 ADR/票据):
- D1 契约一次定形:T4a 的 ParseArtifact 即含可选后端标识与路由表接口,T4b 纯增量
- D2 未列出格式显式拒绝+审计,不引入 tika
- D3 全异步无同步例外,图片无快路径
- D4 Office 解析器自行移植精简版,不直接依赖 ragflow 工程代码
- D5 补 ASCII 管线图(含任务边界与注入检测链)
- D6 PROBE-007 资源画像分冷/热,加 zip 炸弹/超大图对抗性输入
- D7 空产物(无文字图)与加密 Office 的边界语义进探针输入
- D8 单图 OCR 吞吐 P50/P95 与内存同批采集

**VERDICT:** ENG CLEARED — 可进入实现(等用户开工指令)。

NO UNRESOLVED DECISIONS
