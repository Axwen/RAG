# PROBE-007：Office 与图片解析探针（本地，零云成本）

## 目的

在本地实测 DeepDOC OCR 直接解析独立图片文件、Office 内嵌图片提取，以及 docx/pptx/xlsx 格式库的中文结构还原度，产出一份冻结的 `OfficeImageManifest`（各格式选用的提取库、图片 OCR 入口、质量告警阈值），为 ADR-0038 的混合后端与图片 OCR 后端提供决策依据。全程不调用任何云模型。

## 当前依据

- [ADR-0038](../../adr/0038-vlm-parser-backend-and-multimodal-scope.md)（多模态范围重定：OCR 路线，VLM 后置）
- [ADR-0021](../../adr/0021-multi-format-parser-artifact.md)（多格式统一 ParseArtifact）
- [ADR-0014](../../adr/0014-parser-service-around-ragflow-deepdoc.md)
- [ADR-0032](../../adr/0032-untrusted-content-and-prompt-injection.md)
- 参考实现：RAGFlow `rag/app/picture.py`（本地 OCR 为主、CV LLM 可选增强）、`deepdoc/parser/docx_parser.py` / `ppt_parser.py` / `excel_parser.py`
- PROBE-002（DeepDOC 已验证的能力边界：PDF 渲染页 OCR，未覆盖独立图片与 Office 内嵌图）

## 输入与边界

- 测试集：至少 10 张独立图片（客服场景为主：截图、表格截图、聊天记录、流程图、带文字照片，中文为主）+ 至少 3 份真实结构的 DOCX/PPTX/XLSX 样本（含内嵌图片、表格、多级标题）。
- 全部本地运行，走 23.47 GiB 内存画像；不占用任何云预算池。
- 注入样本：1-2 张含提示注入文字的构造图片（验证 OCR 文本进入 `suspected` 判定链的口径）。
- 边界语义样本：OCR 后无文字的图（纯图标/表情包——建议语义：带质量告警入库、可被审核拒绝，探针确认）与加密/密码保护的 Office 文件（建议语义：显式拒绝 + 审计，探针确认）；两个边界在探针报告里定档，T4b 验证项引用。
- 本探针不回答 VLM 相关问题——VLM 已被 ADR-0038 后置到阶段 2 增强槽位。

## 必须验证

1. **独立图片 OCR 质量**：DeepDOC OCR（`deepdoc/vision/ocr.py`）直接跑非 PDF 渲染页的图片——中文识别准确率、bbox 坐标有效性、空白图/损坏图/超大图（超高分辨率）的行为。
2. **Office 内嵌图片提取**：docx/pptx 中内嵌图片能否稳定取出（blob 提取、格式兼容、损坏图兜底），取出后走同一 OCR 入口的质量。
3. **Office 文本与结构还原**：标题层级、段落、表格（行列结构）、PPT 页序、XLSX 工作表/单元格定位的还原度；python 库（python-docx/pptx/xlsx 或移植 deepdoc parser）的选型对比。
4. **统一产物可行性**：上述两类输出能否无损映射进既有 `ParseArtifact`（块列表、bbox/结构位置、质量告警），不改契约或只做加法。
5. **注入判定口径**：图片内 OCR 出的注入文字在 T13 检测链中的判定路径与 PDF 路径一致。
6. **资源画像（冷/热两组）**：OCR 引擎模型加载重（参考实现用进程级 lazy 单例），冷启动（首次加载）与热路径（单例复用）分开测峰值 RSS；批量图片 OCR 与 Office 解析的热路径画像；对抗性输入（zip 炸弹 docx/pptx、超大图）下的内存上界，确认不超 PROBE-002 已冻结的 Parser 资源边界。同批记录单图/单页耗时 P50/P95，供 T10 Worker 并发与入库时长预估使用。
7. **可复现性**：同一输入两次解析产生逐字节相同的块序列与标识。

## 产出

- `probe-007-office-image-parsing.md`（报告，含库选型对比表与质量样本）
- `probe-007-office-image-parsing.json`
- 冻结的 `OfficeImageManifest`：各格式提取库、图片 OCR 入口、降级路径（如损坏图片、空白页）、质量告警阈值。

## 通过标准

- `PASS`：全部格式可产出满足定位与质量要求的 `ParseArtifact`，资源画像在边界内，可冻结 Manifest。
- `PASS_WITH_ADJUSTMENT`：部分格式达标（如 XLSX 表格结构还原差需换库或降级为文本行），路由表收窄但架构不变。
- `BLOCKED`：某格式无法在既有契约内表达，或资源超界。`BLOCKED` 时该格式从 T4b 范围剔除、维持后置，T4a（PDF 主链）不受影响。

## 测试与回滚

- 全程本地运行、零云调用；探针脚本进 `probes/`，不落任何密钥。
- 探针失败删除临时产物即可回滚；不修改业务代码，不写正式 Manifest。
