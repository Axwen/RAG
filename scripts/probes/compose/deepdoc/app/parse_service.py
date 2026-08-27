#!/usr/bin/env python3
"""PROBE-002 in-container parse wrapper (THROWAWAY probe harness).

Wraps the vendored RAGFlow DeepDOC assembly layer behind a tiny stdlib HTTP
service so the host-side probe driver can exercise it over urllib. This is NOT
the future Parser Service — it only proves the DeepDOC parse facts (structured
blocks, page/coordinate positions, table reconstruction, resource envelope).
Service-layer protocol (parserTaskId lifecycle / idempotency / recovery) is
SIMULATED and clearly labelled by the driver, matching the PROBE-004 pattern.

Endpoints:
  GET  /health           -> readiness + tokenizer mode + model presence
  POST /parse?filename=X -> body is the raw file bytes; returns ParseArtifact JSON

DeepDOC parse runs strictly serial (Parser 并发 1) via a module-level lock.
"""
import hashlib
import json
import os
import re
import resource
import tempfile
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PARSER_VERSION = os.environ.get("PARSER_VERSION", "ragflow-deepdoc@618c4599/v0.27.0")
MODEL_DIR = os.path.join(os.environ.get("RAGFLOW_PROJECT_BASE", "/app"), "rag", "res", "deepdoc")

# Serialize DeepDOC parses: Parser 并发 1 (PROJECT_STATE hard boundary).
_PARSE_LOCK = threading.Lock()


def _peak_rss_mib():
    # ru_maxrss is KiB on Linux.
    return round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0, 1)


def _models_present():
    want = ["layout.onnx", "tsr.onnx", "det.onnx", "rec.onnx", "updown_concat_xgb.model"]
    present = {}
    for name in want:
        present[name] = os.path.exists(os.path.join(MODEL_DIR, name))
    return present


def _sha256(b):
    return hashlib.sha256(b).hexdigest()


def _tokenizer_mode():
    try:
        from rag.nlp import USING_STUB_TOKENIZER
        return "stub" if USING_STUB_TOKENIZER else "infinity"
    except Exception:
        return "unknown"


_MD_TABLE_ROW = re.compile(r"^\s*\|.*\|\s*$")
_MD_TABLE_SEP = re.compile(r"^\s*\|?[\s:|-]+\|?\s*$")


def _parse_markdown(text):
    """Structure Markdown into blocks. No PDF coordinates exist for Markdown, so
    `positions` is empty by design; `line_span` records source line ranges as the
    Markdown analogue of a position backlink."""
    lines = text.splitlines()
    blocks = []
    i, n = 0, len(lines)
    while i < n:
        line = lines[i]
        if not line.strip():
            i += 1
            continue
        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if m:
            blocks.append({"layout_type": "title", "level": len(m.group(1)),
                           "text": m.group(2).strip(), "line_span": [i + 1, i + 1],
                           "positions": []})
            i += 1
            continue
        if _MD_TABLE_ROW.match(line):
            start = i
            rows = []
            while i < n and _MD_TABLE_ROW.match(lines[i]):
                if not _MD_TABLE_SEP.match(lines[i]):
                    rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")])
                i += 1
            html = "<table>" + "".join(
                "<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in rows
            ) + "</table>"
            blocks.append({"layout_type": "table", "text": html, "rows": len(rows),
                           "line_span": [start + 1, i], "positions": [],
                           "warning": None if rows else "empty-table"})
            continue
        start = i
        buf = []
        while i < n and lines[i].strip() and not re.match(r"^#{1,6}\s", lines[i]) \
                and not _MD_TABLE_ROW.match(lines[i]):
            buf.append(lines[i].strip())
            i += 1
        blocks.append({"layout_type": "text", "text": " ".join(buf),
                       "line_span": [start + 1, i], "positions": []})
    return blocks


def _serialize_pdf_box(b):
    """Drop the non-serializable PIL `image`; keep text, layout, coords, tags."""
    return {
        "layout_type": b.get("layout_type"),
        "text": b.get("text", ""),
        "page_number": b.get("page_number"),
        "bbox": {"x0": b.get("x0"), "x1": b.get("x1"),
                 "top": b.get("top"), "bottom": b.get("bottom")},
        "position_tag": b.get("position_tag"),
        "positions": b.get("positions", []),
        "has_image": b.get("image") is not None,
    }


def _parse_pdf(path):
    # Import here so a Markdown-only run never touches the ONNX / xgboost stack.
    from deepdoc.parser.pdf_parser import RAGFlowPdfParser
    parser = RAGFlowPdfParser()
    boxes = parser.parse_into_bboxes(path)
    blocks = [_serialize_pdf_box(b) for b in boxes]
    tables = [b for b in blocks if b["layout_type"] == "table"]
    table_warnings = [
        {"page_number": t["page_number"], "reason": "empty-table-text"}
        for t in tables if not (t["text"] or "").strip()
    ]
    located = sum(1 for b in blocks if b["positions"])
    return blocks, {
        "table_count": len(tables),
        "table_warnings": table_warnings,
        "block_count": len(blocks),
        "located_block_count": located,
        "location_rate": round(located / len(blocks), 4) if blocks else 0.0,
    }


def build_artifact(filename, raw):
    ext = os.path.splitext(filename)[1].lower()
    content_hash = _sha256(raw)
    t0 = time.perf_counter()
    if ext in (".md", ".markdown", ".txt"):
        text = _decode_text(raw)
        blocks = _parse_markdown(text)
        tables = [b for b in blocks if b["layout_type"] == "table"]
        quality = {"table_count": len(tables),
                   "table_warnings": [b["warning"] for b in tables if b.get("warning")],
                   "block_count": len(blocks),
                   "located_block_count": 0,
                   "location_rate": None}
        kind = "markdown"
    elif ext == ".pdf":
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tf:
            tf.write(raw)
            tmp = tf.name
        try:
            blocks, quality = _parse_pdf(tmp)
        finally:
            os.unlink(tmp)
        kind = "pdf"
    else:
        raise ValueError(f"unsupported extension: {ext}")
    elapsed = round(time.perf_counter() - t0, 3)
    normalized = "\n\n".join(b.get("text", "") for b in blocks if b.get("text"))
    return {
        "kind": kind,
        "filename": filename,
        "content_hash": content_hash,
        "parser_version": PARSER_VERSION,
        "tokenizer_mode": _tokenizer_mode(),
        "normalized_content": normalized,
        "blocks": blocks,
        "quality": quality,
        "resource": {"parse_seconds": elapsed, "peak_rss_mib": _peak_rss_mib()},
    }


def _decode_text(raw):
    """Decode a text/markdown file to str.

    UTF-8 is by far the dominant real-world encoding and is self-validating, so
    try it (BOM-aware) against the FULL byte string first. Only fall back to the
    stub `find_codec` for genuinely non-UTF-8 input. This avoids the mojibake
    trap where chardet, run on a truncated CJK prefix, confidently mis-detects a
    valid UTF-8 file as a legacy 2-byte codec (gb2312/big5) that happens to
    decode the prefix."""
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        pass
    try:
        from rag.nlp import find_codec
        return raw.decode(find_codec(raw), errors="replace")
    except Exception:
        return raw.decode("utf-8", errors="replace")


def _json_default(o):
    """DeepDOC box coordinates come back as numpy scalars/arrays (float32 etc.)
    which stdlib json can't encode. Coerce them to native Python via the numpy
    duck-typed .item()/.tolist() without hard-importing numpy here."""
    if hasattr(o, "item"):
        return o.item()
    if hasattr(o, "tolist"):
        return o.tolist()
    raise TypeError(f"Object of type {o.__class__.__name__} is not JSON serializable")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False, default=_json_default).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # quieter logs
        pass

    def do_GET(self):
        if urlparse(self.path).path == "/health":
            self._send(200, {"status": "ok", "parser_version": PARSER_VERSION,
                             "tokenizer_mode": _tokenizer_mode(),
                             "models": _models_present(),
                             "peak_rss_mib": _peak_rss_mib()})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/parse":
            self._send(404, {"error": "not found"})
            return
        qs = parse_qs(parsed.query)
        filename = (qs.get("filename") or ["upload.bin"])[0]
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b""
        if not raw:
            self._send(400, {"error": "empty body"})
            return
        # Serial parse: honour Parser 并发 1.
        acquired = _PARSE_LOCK.acquire(blocking=False)
        if not acquired:
            self._send(429, {"error": "parser busy (concurrency 1)"})
            return
        try:
            artifact = build_artifact(filename, raw)
            self._send(200, artifact)
        except Exception as e:
            self._send(500, {"error": str(e), "trace": traceback.format_exc()})
        finally:
            _PARSE_LOCK.release()


def main():
    port = int(os.environ.get("PORT", "9390"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"[parse_service] listening on :{port} tokenizer={_tokenizer_mode()} "
          f"models={_models_present()}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
