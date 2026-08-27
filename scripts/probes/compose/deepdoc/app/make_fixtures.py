#!/usr/bin/env python3
"""PROBE-002 synthetic fixture generator (runs in-container).

Emits fully synthetic, de-identified customer-service PDFs covering the formats
the PROBE-002 ticket mandates: native single-column, double-column, cross-page
table, and a scanned (image-only, no text layer) PDF that forces the OCR path.
No real customer data. Output dir defaults to /fixtures.
"""
import os

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas

OUT = os.environ.get("FIXTURE_OUT", "/fixtures")
os.makedirs(OUT, exist_ok=True)

# A CID-mapped CJK font so Chinese renders as real text (not tofu) in native PDFs.
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont

FONT = "STSong-Light"
pdfmetrics.registerFont(UnicodeCIDFont(FONT))

W, H = A4
PARA = [
    "客服在处理退款时先确认订单状态，再按时效表判断处理路径。所有金额单位为元。",
    "已下单未发货可全额退款，含运费，时效一个工作日。",
    "已发货未签收可退款但扣除运费，时效三个工作日。",
    "已签收七日内需商品完好方可退款，时效五个工作日。",
    "涉及金额超过五百元的争议升级到主管审批，一线客服无法判定时升级到二线。",
]


def native_single(path):
    c = canvas.Canvas(path, pagesize=A4)
    c.setFont(FONT, 16)
    c.drawString(25 * mm, H - 30 * mm, "退款政策概述（合成样本）")
    c.setFont(FONT, 11)
    y = H - 45 * mm
    for p in PARA:
        c.drawString(25 * mm, y, p)
        y -= 9 * mm
    c.setFont(FONT, 11)
    c.drawString(25 * mm, y - 4 * mm, "定位测试句：本句包含数字 12345 与英文 token DEEPDOC。")
    c.showPage()
    c.save()


def double_column(path):
    c = canvas.Canvas(path, pagesize=A4)
    c.setFont(FONT, 16)
    c.drawString(20 * mm, H - 25 * mm, "双栏布局样本")
    c.setFont(FONT, 10)
    col_w = (W - 40 * mm - 8 * mm) / 2
    left_x = 20 * mm
    right_x = 20 * mm + col_w + 8 * mm
    body = (PARA * 3)
    for idx, x in enumerate((left_x, right_x)):
        y = H - 40 * mm
        for p in body[idx * 6:(idx + 1) * 6]:
            for line in _wrap(p, 18):
                c.drawString(x, y, line)
                y -= 6 * mm
            y -= 2 * mm
    c.showPage()
    c.save()


def _wrap(text, n):
    return [text[i:i + n] for i in range(0, len(text), n)]


def cross_page_table(path):
    """A table whose rows span a page break, to exercise cross-page stitching."""
    c = canvas.Canvas(path, pagesize=A4)
    header = ["订单状态", "允许退款", "时效(工作日)", "备注"]
    rows = [
        ["已下单未发货", "是", "1", "全额退款"],
        ["已发货未签收", "是", "3", "扣除运费"],
        ["已签收七日内", "是", "5", "需商品完好"],
        ["已签收超七日", "否", "-", "转售后工单"],
        ["预售订单", "是", "7", "定金规则"],
        ["跨境订单", "是", "10", "含清关"],
        ["虚拟商品", "否", "-", "不支持退款"],
        ["组合套餐", "是", "5", "按主品判定"],
    ]
    col_x = [20 * mm, 60 * mm, 95 * mm, 135 * mm]

    def draw_header(y):
        c.setFont(FONT, 11)
        for x, h in zip(col_x, header):
            c.drawString(x, y, h)
        return y - 8 * mm

    c.setFont(FONT, 14)
    c.drawString(20 * mm, H - 20 * mm, "跨页表格样本")
    y = draw_header(H - 30 * mm)
    c.setFont(FONT, 10)
    for i, r in enumerate(rows):
        if y < 25 * mm:
            c.showPage()
            c.setFont(FONT, 10)
            y = draw_header(H - 20 * mm)
            c.setFont(FONT, 10)
        for x, cell in zip(col_x, r):
            c.drawString(x, y, cell)
        y -= 7 * mm
    c.showPage()
    c.save()


def scanned(path):
    """Image-only PDF (no text layer) -> forces the OCR path."""
    from io import BytesIO

    from PIL import Image, ImageDraw, ImageFont
    from reportlab.lib.utils import ImageReader

    img = Image.new("RGB", (1240, 1754), "white")  # ~150 dpi A4
    d = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype(
            "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", 30)
        big = ImageFont.truetype(
            "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", 44)
    except Exception:
        font = ImageFont.load_default()
        big = font
    d.text((90, 90), "扫描件退款须知（合成样本）", fill="black", font=big)
    y = 200
    for p in PARA:
        d.text((90, y), p, fill="black", font=font)
        y += 70
    d.text((90, y + 20), "扫描定位测试句：编号 67890，token OCRPROBE。",
           fill="black", font=font)
    buf = BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    c = canvas.Canvas(path, pagesize=A4)
    c.drawImage(ImageReader(buf), 0, 0, width=W, height=H)
    c.showPage()
    c.save()


if __name__ == "__main__":
    native_single(os.path.join(OUT, "native_single.pdf"))
    double_column(os.path.join(OUT, "double_column.pdf"))
    cross_page_table(os.path.join(OUT, "cross_page_table.pdf"))
    scanned(os.path.join(OUT, "scanned.pdf"))
    print("[make_fixtures] wrote:", sorted(os.listdir(OUT)), flush=True)
