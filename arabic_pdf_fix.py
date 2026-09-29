from __future__ import annotations

import os
from pathlib import Path

from bidi.algorithm import get_display
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

try:
    import arabic_reshaper
except ImportError as exc:  # pragma: no cover
    raise SystemExit(
        "Missing dependency: arabic_reshaper. Install it with: pip install arabic-reshaper python-bidi reportlab"
    ) from exc


def find_arabic_font() -> str:
    """Find a Unicode Arabic-capable TrueType font on the system."""
    candidates = [
        os.environ.get("ARABIC_FONT"),
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
        "C:/Windows/Fonts/arial.ttf",
        "C:/Windows/Fonts/Amiri-Regular.ttf",
        "C:/Windows/Fonts/Cairo-Regular.ttf",
        "/System/Library/Fonts/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ]

    for candidate in candidates:
        if not candidate:
            continue
        if os.path.exists(candidate):
            return candidate

    raise FileNotFoundError(
        "No Arabic-capable TTF font was found. Set the ARABIC_FONT environment variable to a valid .ttf path."
    )


def make_rtl_arabic(text: str) -> str:
    """Reshape Arabic glyphs and reorder them for correct RTL display."""
    reshaped = arabic_reshaper.reshape(text)
    return get_display(reshaped)


def generate_pdf(output_path: str = "output/arabic_sample.pdf") -> str:
    font_path = find_arabic_font()
    pdfmetrics.registerFont(TTFont("ArabicFont", font_path))

    output_file = Path(output_path)
    output_file.parent.mkdir(parents=True, exist_ok=True)

    page_width, page_height = A4
    margin = 40

    pdf = canvas.Canvas(str(output_file), pagesize=A4)
    pdf.setTitle("Arabic RTL PDF Sample")
    pdf.setFont("ArabicFont", 22)

    title = make_rtl_arabic("دليل عربي صحيح للعرض في ملفات PDF")
    pdf.drawRightString(page_width - margin, page_height - 60, title)

    body = make_rtl_arabic(
        "هذا مثال على نص عربي يتم معالجته بشكل صحيح قبل الطباعة. "
        "يتم أولاً تشكيل الحروف العربية ثم إعادة ترتيبها بصيغة RTL، "
        "لتفادي ظهور الرموز الإنجليزية المشوشة مثل Þ\"þÖþØþ."
    )

    pdf.setFont("ArabicFont", 16)
    pdf.drawRightString(page_width - margin, page_height - 120, body)

    pdf.setFont("ArabicFont", 14)
    notes = [
        make_rtl_arabic("المفتاح هنا هو استخدام arabic_reshaper + python-bidi."),
        make_rtl_arabic("ثم تسجيل خط عربي يدعم UTF-8 مثل DejaVu Sans أو Arial أو Amiri."),
        make_rtl_arabic("وبذلك تظهر الحروف من اليمين إلى اليسار دون تشويه أو رموز عشوائية."),
    ]

    y = page_height - 180
    for note in notes:
        y -= 28
        pdf.drawRightString(page_width - margin, y, note)

    pdf.showPage()
    pdf.save()
    return str(output_file)


if __name__ == "__main__":
    path = generate_pdf()
    print(f"Arabic PDF created successfully: {path}")
