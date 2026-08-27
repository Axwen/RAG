# PROBE-002 stub: rag.prompts.generator subset.
# pdf_parser.py imports vision_llm_describe_prompt at module level for the
# VisionParser (LLM-described figures) path, which this probe does NOT exercise.
# The stub satisfies the import; if ever called it returns an empty instruction.
def vision_llm_describe_prompt(page=None) -> str:
    return ""
