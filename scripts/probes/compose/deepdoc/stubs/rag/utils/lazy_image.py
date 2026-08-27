# PROBE-002 stub: rag.utils.lazy_image for the DeepDOC parser probe.
# deepdoc/vision/operators.py imports ensure_pil_image at module level and calls
# it on the OCR text-detection path. The real module imports concat_img from
# rag.nlp, which would pull in the full NLP stack. The parser path only ever
# hands real PIL images to the vision operators, so a passthrough suffices.
from PIL import Image


def ensure_pil_image(img):
    if isinstance(img, Image.Image):
        return img
    return None
