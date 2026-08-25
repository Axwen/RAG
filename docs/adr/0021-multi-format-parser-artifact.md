---
status: accepted
---

# 多格式解析统一产出可定位解析产物

PDF、DOCX、PPTX、XLSX、Markdown、CSV、JSON 等格式通过 Parser Adapter 进入统一解析协议。解析结果至少包含规范化 Markdown、结构化 AST/块列表、页码或工作表/幻灯片定位、bbox/单元格范围、原始资产 URI、解析器版本和质量告警。检索层只消费统一的块协议，不按文件后缀分支。

Office 文档可以使用格式专用库提取结构，再转为统一 Markdown/AST；表格必须同时保留可检索文本、结构化单元格和原始预览。低置信度解析进入校对或拒绝发布，不允许把解析错误静默变成可回答事实。RAGFlow DeepDOC 继续作为复杂 PDF/扫描件 Parser Service 的参考实现，Office/PPTX/XLSX 由独立 Adapter 逐步补齐。
