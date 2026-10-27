#!/usr/bin/env python3
"""Kiểm tra thư mục evidence/ trước khi chèn vào báo cáo Word."""
import os, re, sys
from pathlib import Path
try:
    from PIL import Image
except ImportError:
    sys.exit("Cần Pillow: pip install pillow")

HERE = Path(__file__).resolve().parent
EXPECTED = [f"fig4_{i}.png" for i in range(1, 13)]
MIN_WIDTH, MAX_MB = 1600, 8
PATTERNS = [r"neo4j\+s?://", r"rediss?://", r"bearer\s+[a-z0-9\-_\.]{20,}", r"password\s*[:=]", r"upstash\.io", r"databases\.neo4j\.io"]

ocr = None
try:
    import pytesseract, shutil
    if shutil.which("tesseract"):
        ocr = pytesseract
except Exception:
    pass

problems = 0
print(f"{'File':<14}{'Trạng thái':<12}Ghi chú")
for name in EXPECTED:
    p = HERE / name
    if not p.exists():
        print(f"{name:<14}{'THIẾU':<12}chưa có ảnh"); problems += 1; continue
    notes = []
    im = Image.open(p).convert("L")
    w, h = im.size
    if w < MIN_WIDTH: notes.append(f"rộng {w}px < {MIN_WIDTH}")
    if p.stat().st_size > MAX_MB * 1024 * 1024: notes.append("file > %d MB" % MAX_MB)
    small = im.resize((64, 64))
    lo, hi = small.getextrema()
    if hi - lo < 12: notes.append("ảnh gần như một màu (trắng/đen)")
    if h > 3 * w: notes.append("ảnh quá cao, có thể bị lỗi hiển thị")
    if ocr:
        text = ocr.image_to_string(Image.open(p)).lower()
        hits = [pt for pt in PATTERNS if re.search(pt, text)]
        if hits: notes.append("NGHI LỘ THÔNG TIN: " + ", ".join(hits))
    status = "OK" if not notes else "CẦN XEM"
    if notes: problems += 1
    print(f"{name:<14}{status:<12}{'; '.join(notes) or f'{w}x{h}'}")
extra = sorted(f.name for f in HERE.glob("*.png") if f.name not in EXPECTED)
if extra: print("\nFile lạ (agent sẽ bỏ qua):", ", ".join(extra))
if not ocr: print("\nLưu ý: chưa có tesseract/pytesseract nên KHÔNG quét được chuỗi nhạy cảm; hãy tự xem từng ảnh.")
print(f"\nTổng: {problems} ảnh cần xử lý.")
sys.exit(1 if problems else 0)
