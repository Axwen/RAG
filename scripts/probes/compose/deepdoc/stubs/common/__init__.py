# PROBE-002 stub: minimal common.__init__ for the DeepDOC parser probe.
#
# The real common.settings transitively imports RAGFlow's entire storage / DB /
# connector layer. The parser + vision path only reads two settings attributes:
#   - PARALLEL_DEVICES  (deepdoc/vision/ocr.py, layout recognizer)
#   - DOC_ENGINE_INFINITY (rag_tokenizer: picks infinity vs. builtin tokenize)
# We expose exactly those, sourced from env, and nothing else.
import os


def _as_bool(v: str) -> bool:
    return str(v).strip().lower() in ("1", "true", "yes", "on")


class _Settings:
    PARALLEL_DEVICES = int(os.environ.get("PARALLEL_DEVICES", "0"))
    # False -> the (real, when installed) rag_tokenizer uses its builtin path;
    # our stub tokenizer ignores this flag entirely.
    DOC_ENGINE_INFINITY = _as_bool(os.environ.get("DOC_ENGINE_INFINITY", "0"))


settings = _Settings()
