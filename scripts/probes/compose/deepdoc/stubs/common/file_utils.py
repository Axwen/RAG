# PROBE-002 stub: common.file_utils for the DeepDOC parser probe.
# In the container the project root is always /app (override via RAGFLOW_PROJECT_BASE).
# Model files live under <base>/rag/res/deepdoc.
import os

_PROJECT_BASE = None


def get_project_base_directory(*args):
    global _PROJECT_BASE
    if _PROJECT_BASE is None:
        _PROJECT_BASE = os.environ.get("RAGFLOW_PROJECT_BASE", "/app")
    if args:
        return os.path.join(_PROJECT_BASE, *args)
    return _PROJECT_BASE
