#!/usr/bin/env python3
"""PROBE-002 model fetch: DeepDOC ONNX perception models + xgboost merge model.

Downloads into <target>/ (the container's /app/rag/res/deepdoc):
  InfiniFlow/deepdoc          -> layout.onnx, det.onnx, rec.onnx, tsr.onnx, ocr.res
  InfiniFlow/text_concat_xgb_v1.0 -> updown_concat_xgb.model (paragraph-merge brain)

Honours HF_ENDPOINT (build sets it to the hf-mirror). Idempotent: existing files
are skipped so image rebuilds don't re-download.
"""
import os
import sys

from huggingface_hub import hf_hub_download

DEEPDOC_FILES = ["layout.onnx", "det.onnx", "rec.onnx", "tsr.onnx", "ocr.res"]
XGB_REPO = "InfiniFlow/text_concat_xgb_v1.0"
XGB_FILE = "updown_concat_xgb.model"


def main():
    target = sys.argv[1] if len(sys.argv) > 1 else "/app/rag/res/deepdoc"
    os.makedirs(target, exist_ok=True)
    endpoint = os.environ.get("HF_ENDPOINT", "https://huggingface.co")

    def fetch(repo_id, filename):
        dest = os.path.join(target, filename)
        if os.path.exists(dest):
            print(f"  SKIP {filename}", flush=True)
            return
        print(f"  DOWNLOAD {repo_id}/{filename} ...", flush=True)
        hf_hub_download(repo_id=repo_id, filename=filename,
                        local_dir=target, endpoint=endpoint)
        print(f"  OK {filename}", flush=True)

    for f in DEEPDOC_FILES:
        fetch("InfiniFlow/deepdoc", f)
    fetch(XGB_REPO, XGB_FILE)
    print(f"All models in {os.path.abspath(target)}: {sorted(os.listdir(target))}",
          flush=True)


if __name__ == "__main__":
    main()
