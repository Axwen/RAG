# PROBE-002 stub: rag.nlp subset used by the DeepDOC PDF parser path.
#
# Two consumers:
#   - deepdoc/parser/utils.py         -> find_codec
#   - deepdoc/parser/pdf_parser.py    -> rag_tokenizer.{tokenize,tag,is_chinese}
#   - deepdoc/vision/table_structure_recognizer.py -> rag_tokenizer (import only)
#
# Fast-first-green mode (Stage A): the real infinity-sdk tokenizer is NOT
# installed, so tokenize/tag run in a DEGRADED builtin fallback. This weakens
# the xgboost paragraph-merge features (`_updown_concat_features`) but keeps the
# pipeline running end-to-end. The wrapper reports USING_STUB_TOKENIZER=True so
# the probe artifact stays honest about merge fidelity. Stage B swaps in the real
# infinity rag_tokenizer for the faithful hard-sample report.
import re

import chardet

USING_STUB_TOKENIZER = True

# Common text encodings, ordered so the most likely candidates win the decode race.
all_codecs = [
    "utf-8", "gb2312", "gbk", "gb18030", "big5",
    "utf-16", "utf-16-le", "utf-16-be", "latin-1", "ascii",
]

_CJK = re.compile(r"[一-鿿㐀-䶿]")


def find_codec(blob):
    # UTF-8 first: it is self-validating on the FULL blob, so a clean decode is
    # decisive and beats any chardet guess. Validating the whole blob (not a
    # 1024-byte prefix) is what prevents a legacy 2-byte codec from "winning"
    # merely because it decodes a truncated CJK prefix.
    try:
        blob.decode("utf-8")
        return "utf-8"
    except Exception:
        pass
    detected = chardet.detect(blob)
    if detected and detected.get("confidence", 0) > 0.5:
        enc = detected.get("encoding")
        if enc and enc.lower() == "ascii":
            return "utf-8"
        if enc:
            try:
                blob.decode(enc)
                return enc
            except Exception:
                pass
    for c in all_codecs:
        try:
            blob.decode(c)
            return c
        except Exception:
            pass
    return "utf-8"


def is_chinese(s):
    if not s:
        return False
    return bool(_CJK.match(s[0]))


def is_number(s):
    return bool(s) and bool(re.match(r"^[0-9]+$", s))


def is_alphabet(s):
    return bool(s) and bool(re.match(r"^[a-zA-Z]+$", s))


class _FallbackTokenizer:
    """Degraded, dependency-free stand-in for infinity rag_tokenizer.

    tokenize(): normalises whitespace so callers' `.split()` yields a token list.
                Chinese runs collapse to a single token (no word segmentation) —
                acceptable for a first-green run, flagged via USING_STUB_TOKENIZER.
    tag():      returns "" (no POS); merge features that inspect POS just see no-n.
    """

    def tokenize(self, text):
        if text is None:
            return ""
        return " ".join(str(text).split())

    def tag(self, word):
        return ""

    is_chinese = staticmethod(is_chinese)
    is_number = staticmethod(is_number)
    is_alphabet = staticmethod(is_alphabet)


rag_tokenizer = _FallbackTokenizer()
