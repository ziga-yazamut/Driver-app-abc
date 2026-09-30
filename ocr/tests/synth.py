"""מחולל שיקים סינתטיים לבדיקות.

השיק נבנה מאפס: רקע, שורה מודפסת עליונה, פרטי מושך בדויים, ושורת MICR שמורכבת מצורות תווי E-13B
(tests/assets/e13b_glyphs.npz, צורות הגופן בלבד). אחר כך הוא מונח על "שולחן" ומעוות כמו צילום טלפון.

חשוב: צורות התווים לקוחות מאותו שיק שממנו נלמדו התבניות, ולכן הבדיקות האלה בודקות את הצינור
(איתור, יישור, חלוקה, הצלבה, סימון לבדיקה) עם מספרים שונים, ולא את הדיוק על שיקים של בנקים אחרים.
"""
from __future__ import annotations

import os
import random
from dataclasses import dataclass

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
_G = np.load(os.path.join(HERE, "assets", "e13b_glyphs.npz"))


def _clean(g):
    """רקע התא ללבן, דיו נשאר כהה."""
    g = g.astype(np.float32)
    lo, hi = np.percentile(g, 2), np.percentile(g, 85)
    return np.clip((g - lo) / max(hi - lo, 1) * 255, 0, 255).astype(np.uint8)


GLYPHS = {k: _clean(_G[k]) for k in _G.files}
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
KNOWN_DIGITS = "012345679"   # 8 עוד לא נלמד


def valid_id(rng: random.Random) -> str:
    body = [rng.randint(0, 9) for _ in range(8)]
    tot = 0
    for i, d in enumerate(body):
        v = d * (1 if i % 2 == 0 else 2)
        tot += v - 9 if v > 9 else v
    return "".join(map(str, body)) + str((10 - tot % 10) % 10)


@dataclass
class Spec:
    check_no: str
    bank: str
    branch_field: str   # 5 ספרות: סניף (3) + 2
    account: str
    drawer_id: str
    drawer_name: str = "ישראל ישראלי"
    printed_line: bool = True
    printed_override: str | None = None   # שורה עליונה שונה מה-MICR (בדיקת אי-התאמה)

    @property
    def branch(self):
        return self.branch_field[:3]


def random_spec(rng: random.Random, digits=KNOWN_DIGITS, bank=None) -> Spec:
    d = lambda n: "".join(rng.choice(digits) for _ in range(n))  # noqa: E731
    bank = bank or rng.choice(["10", "11", "12", "20", "31", "17", "14", "54"])
    return Spec(check_no=d(rng.choice([7, 8])), bank=bank, branch_field=d(5),
                account=d(rng.choice([6, 8, 9])), drawer_id=valid_id(rng))


def _glyph(label: str, fake8=False) -> np.ndarray:
    if label == "8":
        g = GLYPHS["0"].copy()
        h = g.shape[0]
        g[h // 2 - 2:h // 2 + 3, 8:-8] = g.min()   # "8" מאולתר: אפס עם פס באמצע
        return g
    return GLYPHS[label]


def render(spec: Spec, rng: random.Random | None = None) -> np.ndarray:
    """שיק ישר, 1900x840, BGR."""
    rng = rng or random.Random(0)
    W, H = 1900, 840
    bg = np.full((H, W, 3), (246, 243, 228), np.uint8)
    bg = (bg.astype(np.int16) + np.random.default_rng(rng.randint(0, 1 << 30)).integers(-4, 5, bg.shape)).clip(0, 255).astype(np.uint8)
    pil = Image.fromarray(cv2.cvtColor(bg, cv2.COLOR_BGR2RGB))
    dr = ImageDraw.Draw(pil)
    fb, f = ImageFont.truetype(FONT_BOLD, 30), ImageFont.truetype(FONT, 30)
    ink = (45, 50, 60)
    # כותרת בנק + סניף
    dr.rectangle((65, 25, 500, 145), fill=(40, 90, 200))
    dr.text((480, 170), f"סניף {spec.branch} עסקים מרכז", font=fb, fill=ink, anchor="ra", direction="rtl")
    dr.text((880, 210), "רח' הדוגמה 10 תל אביב טל' 03-0000000", font=f, fill=ink, anchor="ra", direction="rtl")
    if spec.printed_line:
        line = spec.printed_override or f"{spec.check_no} {spec.bank} {spec.branch_field} {spec.account}"
        dr.text((65, 245), line, font=fb, fill=ink)
    # פרטי המושך
    for i, t in enumerate([spec.drawer_name, "רחוב הדוגמה 1 עיר", spec.drawer_id, "050-0000000"]):
        dr.text((1835, 25 + i * 42), t, font=fb, fill=ink, anchor="ra", direction="rtl")
    # קווים וכתב יד מדומה
    for y in (370, 460, 630):
        dr.line((65, y, 1350, y), fill=(60, 80, 170), width=3)
    for _ in range(6):
        x = rng.randint(500, 1300)
        y = rng.choice([330, 430, 600])
        dr.line((x, y, x + rng.randint(40, 120), y + rng.randint(-30, 30)), fill=(30, 30, 70), width=4)
    dr.text((95, 780), "Cheque No.        Branch No.        Account no.", font=ImageFont.truetype(FONT, 20), fill=(90, 110, 170))
    img = cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)

    # שורת MICR
    seq = (["S0"] + list(spec.check_no) + [None, "S1"] + list(spec.bank) + ["S2"] + list(spec.branch_field)
           + ["S3", None] + list(spec.account) + ["S4"])
    x, y = 75, 715
    pitch = 38
    for lab in seq:
        if lab is None:
            x += pitch
            continue
        g = _glyph(lab)
        s = rng.uniform(0.97, 1.03)
        g = cv2.resize(g, None, fx=s, fy=s)
        h, w = g.shape
        yy = y + rng.randint(-1, 1)
        roi = img[yy:yy + h, x:x + w]
        gg = cv2.cvtColor(g, cv2.COLOR_GRAY2BGR)
        img[yy:yy + h, x:x + w] = np.minimum(roi, gg)
        x += pitch
    return img


def photograph(check: np.ndarray, rng: random.Random, severity: float = 1.0) -> np.ndarray:
    """מניח על שולחן ומעוות כמו צילום: סיבוב 90°, הטיה, פרספקטיבה, תאורה, טשטוש, דחיסה."""
    H, W = check.shape[:2]
    pad = 260
    canvas = np.full((H + 2 * pad, W + 2 * pad, 3), rng.randint(20, 70), np.uint8)
    canvas[pad:pad + H, pad:pad + W] = check
    h2, w2 = canvas.shape[:2]
    d = 0.05 * severity
    src = np.float32([[pad, pad], [pad + W, pad], [pad + W, pad + H], [pad, pad + H]])
    jit = lambda: rng.uniform(-d, d) * W  # noqa: E731
    dst = src + np.float32([[jit(), jit()] for _ in range(4)])
    img = cv2.warpPerspective(canvas, cv2.getPerspectiveTransform(src, dst), (w2, h2), borderValue=(40, 40, 40))
    M = cv2.getRotationMatrix2D((w2 / 2, h2 / 2), rng.uniform(-8, 8) * severity, 1)
    img = cv2.warpAffine(img, M, (w2, h2), borderValue=(40, 40, 40))
    img = cv2.rotate(img, rng.choice([cv2.ROTATE_90_CLOCKWISE, cv2.ROTATE_90_COUNTERCLOCKWISE, cv2.ROTATE_180])) \
        if rng.random() < 0.75 else img
    # תאורה
    g = np.linspace(rng.uniform(1 - 0.4 * severity, 1), 1, img.shape[1])[None, :, None]
    img = (img * g * rng.uniform(0.75, 1.1)).clip(0, 255).astype(np.uint8)
    k = rng.choice([0, 3, 5] if severity <= 1 else [3, 5, 7, 9])
    if k:
        img = cv2.GaussianBlur(img, (k, k), 0)
    img = cv2.imdecode(cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, rng.randint(45, 90)])[1], 1)
    return img
