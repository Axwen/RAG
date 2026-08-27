# PROBE-002 stub: common.misc_utils subset used by the DeepDOC parser path.
#   - pip_install_torch(): called inside load_model()'s CUDA guard; on CPU it is a
#     no-op, letting onnxruntime fall back to CPUExecutionProvider.
#   - thread_pool_exec(): awaited by RAGFlowPdfParser.__images__ (OCR launcher).
#     Copied verbatim from references/ragflow/common/misc_utils.py so contextvars
#     propagate into the worker thread and per-call executors avoid the 3.13
#     reuse deadlock noted upstream.
import asyncio
import contextvars
import functools
import logging
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor


def pip_install_torch():
    device = os.getenv("DEVICE", "cpu")
    if device == "cpu":
        return
    logging.info("Installing pytorch")
    pkg_names = ["torch>=2.5.0,<3.0.0"]
    subprocess.check_call([sys.executable, "-m", "pip", "install", *pkg_names])


async def thread_pool_exec(func, *args, **kwargs):
    loop = asyncio.get_running_loop()
    ctx = contextvars.copy_context()
    with ThreadPoolExecutor(max_workers=1) as executor:
        if kwargs:
            inner = functools.partial(func, *args, **kwargs)
            return await loop.run_in_executor(executor, ctx.run, inner)
        return await loop.run_in_executor(executor, ctx.run, func, *args)
