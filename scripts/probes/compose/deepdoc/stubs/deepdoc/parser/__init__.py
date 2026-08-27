# PROBE-002 stub: emptied deepdoc.parser package __init__.
# The real references/ragflow/deepdoc/parser/__init__.py eagerly imports every
# parser (docx/epub/excel/html/json/markdown/pdf/ppt/txt), each dragging in heavy
# dependencies. For this probe we only need the PDF path, imported directly as
# `deepdoc.parser.pdf_parser`. Keeping this __init__ empty avoids the rest.
