"""OCR לשיקים ישראליים.

מה נקרא מהשיק (טקסט מודפס בלבד, לא כתב יד):
  - שורת MICR בתחתית השיק (גופן E-13B): מס' שיק, בנק, שדה סניף, חשבון
  - השורה המודפסת העליונה (אותם מספרים בגופן רגיל) לאימות צולב
  - שם המושך, ת"ז/ח.פ. וטלפון מהפינה העליונה
סכום ותאריך פירעון הם בכתב יד ולכן לא נקראים: הנהג מקליד אותם.

שימוש:
  python check_ocr.py photo.jpg            # מדפיס JSON
  python check_ocr.py photo.jpg --debug d/ # שומר תמונות ביניים

תלויות: opencv-python-headless, numpy, pytesseract + tesseract-ocr, tesseract-ocr-heb.
"""
from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import dataclass, field, asdict

# Tesseract עם כמה threads בכמה תהליכים במקביל נתקע. thread אחד לכל קריאה.
os.environ.setdefault("OMP_THREAD_LIMIT", "1")

import cv2  # noqa: E402
import numpy as np  # noqa: E402
import pytesseract  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATES_PATH = os.path.join(HERE, "e13b_templates.npz")

NORM_W = 1900          # רוחב השיק אחרי יישור
GLYPH_W, GLYPH_H = 24, 32
MIN_SHARPNESS = 20.0   # מתחת לזה התמונה מטושטשת מדי (כויל על טשטוש מלאכותי)
MIN_NATIVE_W = 600     # רוחב שיק מינימלי בפיקסלים בצילום המקורי
TESS_TIMEOUT = 8        # שניות לקריאת Tesseract. תמונה שנתקעת מסומנת לבדיקה
MIN_GLYPH_SCORE = 0.55
MIN_GLYPH_MARGIN = 0.05

BANKS = {
    "04": "בנק יהב", "09": "בנק הדואר", "10": "בנק לאומי", "11": "בנק דיסקונט",
    "12": "בנק הפועלים", "13": "בנק אגוד", "14": "בנק אוצר החייל", "17": "בנק מרכנתיל דיסקונט",
    "20": "בנק מזרחי טפחות", "22": "Citibank", "23": "HSBC", "26": "יובנק", "31": "הבנק הבינלאומי",
    "34": "בנק ערבי ישראלי", "46": "בנק מסד", "52": "בנק פועלי אגודת ישראל", "54": "בנק ירושלים",
    "68": "בנק דקסיה / מוניציפל", "18": "וואן זירו",
}


# ---------- עזר ----------

def _tess(img, lang, config):
    """Tesseract עם הגבלת זמן. אם נתקע, מחזיר מחרוזת ריקה (והשדה יסומן כלא נקרא)."""
    try:
        return pytesseract.image_to_string(img, lang=lang, config=config, timeout=TESS_TIMEOUT)
    except RuntimeError:
        return ""


def israeli_id_valid(s: str) -> bool:
    """ספרת ביקורת של ת"ז / ח.פ. ישראלי (9 ספרות)."""
    if not re.fullmatch(r"\d{5,9}", s):
        return False
    s = s.zfill(9)
    tot = 0
    for i, ch in enumerate(s):
        v = int(ch) * (1 if i % 2 == 0 else 2)
        tot += v - 9 if v > 9 else v
    return tot % 10 == 0


def load_branches(path: str | None) -> set[tuple[str, str]] | None:
    """רשימת סניפים של בנק ישראל (CSV: bank,branch). אם אין קובץ, מדלגים על הבדיקה."""
    if not path or not os.path.exists(path):
        return None
    out = set()
    with open(path, encoding="utf-8") as f:
        for line in f:
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit():
                out.add((parts[0].zfill(2), parts[1].zfill(3)))
    return out


# ---------- 1. מציאת השיק ויישורו ----------

def _order(pts):
    s = pts.sum(1)
    d = np.diff(pts, axis=1).ravel()
    return np.array([pts[np.argmin(s)], pts[np.argmin(d)], pts[np.argmax(s)], pts[np.argmax(d)]], np.float32)


def find_check(img: np.ndarray) -> tuple[np.ndarray, int]:
    """מוצא את הנייר הבהיר בתמונה, מיישר פרספקטיבה ומחזיר שיק לרוחב."""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    # סף בהירות יחסי לתמונה (עובד גם בתמונה כהה/בהירה מדי ובצל)
    v = cv2.GaussianBlur(hsv[..., 2], (0, 0), 3)
    v_thr, _ = cv2.threshold(v, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    s_lim = max(60, int(np.percentile(hsv[..., 1], 60)))
    mask = ((v > v_thr) & (hsv[..., 1] < s_lim)).astype(np.uint8) * 255
    k = max(5, min(img.shape[:2]) // 50)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((k, k), np.uint8))
    cs, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    warped = None
    if cs:
        c = max(cs, key=cv2.contourArea)
        if cv2.contourArea(c) > 0.15 * img.shape[0] * img.shape[1]:
            hull = cv2.convexHull(c)
            peri = cv2.arcLength(hull, True)
            quad = None
            for eps in (0.01, 0.02, 0.03, 0.05, 0.08):
                q = cv2.approxPolyDP(hull, eps * peri, True)
                if len(q) == 4:
                    quad = q.reshape(4, 2).astype(np.float32)
                    break
            if quad is None:
                quad = cv2.boxPoints(cv2.minAreaRect(c)).astype(np.float32)
            tl, tr, br, bl = _order(quad)
            w = int(max(np.linalg.norm(tr - tl), np.linalg.norm(br - bl)))
            h = int(max(np.linalg.norm(bl - tl), np.linalg.norm(br - tr)))
            M = cv2.getPerspectiveTransform(np.array([tl, tr, br, bl]),
                                            np.array([[0, 0], [w, 0], [w, h], [0, h]], np.float32))
            warped = cv2.warpPerspective(img, M, (w, h))
    if warped is None:          # לא נמצא נייר: מניחים שהשיק ממלא את התמונה
        warped = img.copy()
    if warped.shape[0] > warped.shape[1]:
        warped = cv2.rotate(warped, cv2.ROTATE_90_CLOCKWISE)
    native_w = warped.shape[1]
    scale = NORM_W / native_w
    interp = cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC
    return cv2.resize(warped, (NORM_W, int(warped.shape[0] * scale)), interpolation=interp), native_w


def flatten_light(gray: np.ndarray) -> np.ndarray:
    """מנטרל צל ותאורה לא אחידה: מחלקים ברקע מטושטש."""
    bg = cv2.morphologyEx(gray, cv2.MORPH_CLOSE, np.ones((31, 31), np.uint8))
    bg = cv2.GaussianBlur(bg, (0, 0), 15)
    out = cv2.divide(gray, bg, scale=235)
    return cv2.normalize(out, None, 0, 255, cv2.NORM_MINMAX)


def sharpness(gray: np.ndarray) -> float:
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


# ---------- 2. שורת MICR ----------

@dataclass
class Glyph:
    x0: int
    x1: int
    img: np.ndarray


def _binarize(gray):
    b = cv2.GaussianBlur(gray, (5, 5), 0)
    _, t = cv2.threshold(b, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    return cv2.morphologyEx(t, cv2.MORPH_CLOSE, np.ones((5, 3), np.uint8))


def _runs(col, thr=1):
    runs, start = [], None
    for x, v in enumerate(col):
        if v > thr and start is None:
            start = x
        elif v <= thr and start is not None:
            runs.append((start, x))
            start = None
    if start is not None:
        runs.append((start, len(col)))
    return runs


def find_micr_band(gray: np.ndarray):
    """מחפש בתחתית השיק את השורה עם הכי הרבה תווים בגובה ורוחב אחידים (סימן ל-MICR)."""
    h, w = gray.shape
    best = None
    y_start = int(0.70 * h)
    step = max(4, h // 150)
    band_h = int(0.065 * h)
    for y in range(y_start, h - band_h, step):
        t = _binarize(gray[y:y + band_h, int(0.01 * w):int(0.75 * w)])
        runs = [r for r in _runs((t > 0).sum(0)) if 0.012 * w < r[1] - r[0] < 0.03 * w]
        if len(runs) < 10:
            continue
        widths = np.array([r[1] - r[0] for r in runs])
        uniform = (np.abs(widths - np.median(widths)) < 0.25 * np.median(widths)).mean()
        # מלאות: תו MICR ממלא את רוב גובה הרצועה
        fill = np.mean([(t[:, a:b] > 0).any(1).mean() for a, b in runs])
        score = len(runs) * uniform * fill
        if best is None or score > best[0]:
            best = (score, y)
    if best is None:
        return None
    y = best[1]
    # הידוק: שורות שיש בהן דיו
    region = gray[max(0, y - band_h // 2):min(h, y + band_h + band_h // 2), :int(0.75 * w)]
    t = _binarize(region)
    rows = (t > 0).sum(1)
    ys = np.where(rows > 0.02 * t.shape[1])[0]
    if len(ys) == 0:
        return None
    # הקבוצה הרציפה הגדולה ביותר
    groups = np.split(ys, np.where(np.diff(ys) > 2)[0] + 1)
    g = max(groups, key=len)
    y0 = max(0, y - band_h // 2) + g[0] - 3
    y1 = max(0, y - band_h // 2) + g[-1] + 4
    return y0, y1


def segment_micr(gray: np.ndarray, band) -> list[Glyph]:
    y0, y1 = band
    w = gray.shape[1]
    strip = gray[y0:y1, : int(0.75 * w)]
    t = _binarize(strip)
    runs = [r for r in _runs((t > 0).sum(0)) if r[1] - r[0] > 0.004 * w]
    glyphs = []
    for a, b in runs:
        cell = t[:, a:b]
        ys = np.where(cell.any(1))[0]
        if len(ys) < 0.3 * t.shape[0]:
            continue
        glyphs.append(Glyph(a, b, cell))
    return glyphs


def glyph_vec(cell: np.ndarray, pitch: float) -> np.ndarray:
    """תא בגובה מלא ובתוספת רווח לרוחב הפסיעה הקבועה, מנורמל לגודל קבוע."""
    h, w = cell.shape
    pw = max(w, int(round(pitch)))
    pad = np.zeros((h, pw), np.uint8)
    off = (pw - w) // 2
    pad[:, off:off + w] = cell
    ys = np.where(pad.any(1))[0]
    pad = pad[ys[0]:ys[-1] + 1]
    v = cv2.resize(pad, (GLYPH_W, GLYPH_H), interpolation=cv2.INTER_AREA).astype(np.float32)
    v -= v.mean()
    n = np.linalg.norm(v)
    return (v / n).ravel() if n else v.ravel()


class Templates:
    """ספריית תבניות E-13B. נבנית מצילומים שאומתו ידנית ומשתפרת עם כל שיק מאושר."""

    def __init__(self, path=TEMPLATES_PATH):
        self.path = path
        self.vecs: list[np.ndarray] = []
        self.labels: list[str] = []
        if os.path.exists(path):
            d = np.load(path)
            self.vecs = list(d["vecs"])
            self.labels = [str(x) for x in d["labels"]]

    def save(self):
        np.savez_compressed(self.path, vecs=np.array(self.vecs), labels=np.array(self.labels))

    def add(self, vec, label):
        self.vecs.append(vec)
        self.labels.append(label)

    def classify(self, vec):
        if not self.vecs:
            return "?", 0.0, 0.0
        sims = np.array(self.vecs) @ vec
        best = {}
        for s, l in zip(sims, self.labels):
            best[l] = max(best.get(l, -1), float(s))
        ranked = sorted(best.items(), key=lambda kv: -kv[1])
        lab, sc = ranked[0]
        margin = sc - (ranked[1][1] if len(ranked) > 1 else 0)
        if sc < MIN_GLYPH_SCORE or margin < MIN_GLYPH_MARGIN:
            return "?", sc, margin
        return lab, sc, margin


def _pitch(glyphs):
    if len(glyphs) < 2:
        return 30.0
    return float(np.median([g.x1 - g.x0 for g in glyphs])) * 1.15


def read_micr(gray, templates: Templates):
    """מחזיר (מחרוזת עם S בין קבוצות, רשימת קבוצות, ציון מינימלי, glyphs)."""
    band = find_micr_band(gray)
    if band is None:
        return None
    glyphs = segment_micr(gray, band)
    pitch = _pitch(glyphs)
    chars, scores = [], []
    for g in glyphs:
        lab, sc, _ = templates.classify(glyph_vec(g.img, pitch))
        chars.append(lab)
        scores.append(sc)
    raw = "".join(chars)
    groups = [x for x in re.split(r"S+", raw) if x]
    return {"band": band, "raw": raw, "groups": groups,
            "min_score": min(scores) if scores else 0.0, "glyphs": glyphs, "pitch": pitch}


# ---------- 3. השורה המודפסת העליונה ----------

PRINTED_RE = re.compile(r"(\d{5,10})\s+(\d{2})\s+(\d{3,6})\s+(\d{5,12})")


def read_printed_line(gray):
    h, w = gray.shape
    region = gray[: int(0.45 * h), : int(0.65 * w)]
    for psm in (6, 4, 11):
        txt = _tess(region, "eng", f"--psm {psm}")
        for line in txt.splitlines():
            m = PRINTED_RE.search(line.replace("O", "0"))
            if m:
                return list(m.groups()), line.strip()
    return None, None


# ---------- 4. פרטי המושך ----------

def read_drawer(gray):
    h, w = gray.shape
    region = gray[: int(0.32 * h), int(0.62 * w):]
    heb = _tess(region, "heb", "--psm 6")
    nums = _tess(region, "eng",
                                       "--psm 6 -c tessedit_char_whitelist=0123456789-")
    lines = [l.strip() for l in heb.splitlines() if re.search(r"[֐-׿]{2,}", l)]
    name = lines[0] if lines else None
    ids = [x for x in re.findall(r"(?<![\d-])\d{9}(?![\d-])", nums)]
    ids_valid = [x for x in ids if israeli_id_valid(x)]
    phone = re.search(r"0\d{1,2}-?\d{7}", nums)
    return {
        "name": name,
        "id": (ids_valid or ids or [None])[0],
        "id_valid": bool(ids_valid),
        "phone": phone.group(0) if phone else None,
        "address": lines[1] if len(lines) > 1 else None,
    }


# ---------- 5. חיבור הכל ----------

def _micr_fields(groups):
    """E-13B ישראלי: [מס' שיק] [בנק] [סניף+2] [חשבון]."""
    if len(groups) != 4:
        return None
    return groups


def analyze(path_or_img, templates: Templates | None = None, branches=None, debug_dir=None) -> dict:
    img = cv2.imread(path_or_img) if isinstance(path_or_img, str) else path_or_img
    if img is None:
        raise ValueError("לא ניתן לקרוא את התמונה")
    templates = templates or Templates()
    reasons: list[str] = []

    check, native_w = find_check(img)
    gray = flatten_light(cv2.cvtColor(check, cv2.COLOR_BGR2GRAY))
    if native_w < MIN_NATIVE_W:
        reasons.append("השיק קטן מדי בתמונה, לצלם מקרוב")

    # כיוון: אם אין MICR בתחתית, מנסים הפוך
    micr = read_micr(gray, templates)
    flipped = cv2.rotate(gray, cv2.ROTATE_180)
    micr_f = read_micr(flipped, templates)

    def quality(m):
        if not m:
            return -1
        return len(m["glyphs"]) * m["min_score"] + 10 * (len(m["groups"]) == 4)

    if quality(micr_f) > quality(micr):
        gray, micr, check = flipped, micr_f, cv2.rotate(check, cv2.ROTATE_180)

    sharp = sharpness(gray)
    if sharp < MIN_SHARPNESS:
        reasons.append("התמונה מטושטשת, לצלם שוב")

    printed, printed_raw = read_printed_line(gray)
    drawer = read_drawer(gray)

    micr_groups = _micr_fields(micr["groups"]) if micr else None
    if not micr:
        reasons.append("שורת MICR לא נמצאה")
    elif "?" in micr["raw"]:
        reasons.append("תווים לא ודאיים בשורת MICR")
    elif not micr_groups:
        reasons.append(f"שורת MICR: {len(micr['groups'])} קבוצות במקום 4")
    if not printed:
        reasons.append("השורה המודפסת העליונה לא נקראה")

    # מקור אמת: שני המקורות חייבים להסכים
    fields = None
    agree = None
    if micr_groups and printed:
        agree = [a.lstrip("0") == b.lstrip("0") for a, b in zip(micr_groups, printed)]
        if all(agree):
            fields = printed
        else:
            names = ["מס' שיק", "בנק", "סניף", "חשבון"]
            bad = [n for n, ok in zip(names, agree) if not ok]
            reasons.append("אי-התאמה בין MICR לשורה המודפסת: " + ", ".join(bad))
            fields = printed
    else:
        fields = printed or micr_groups

    out = {
        "check_no": None, "bank": None, "bank_name": None, "branch": None,
        "branch_field": None, "account": None,
        "drawer": drawer,
        "amount": None, "due_date": None,  # כתב יד: הנהג מקליד
        "sources": {
            "micr": micr["raw"] if micr else None,
            "printed_line": printed_raw,
        },
        "checks": {},
        "sharpness": round(sharp, 1),
    }
    if fields:
        chk, bank, br_field, acct = fields
        bank = bank.zfill(2)
        branch = br_field[:3]
        out.update(check_no=chk, bank=bank, bank_name=BANKS.get(bank), branch=branch,
                   branch_field=br_field, account=acct)
        c = out["checks"]
        c["micr_matches_printed"] = bool(agree and all(agree))
        c["bank_known"] = bank in BANKS
        if not c["bank_known"]:
            reasons.append(f"קוד בנק לא מוכר: {bank}")
        if branches is not None:
            c["branch_known"] = (bank, branch) in branches
            if not c["branch_known"]:
                reasons.append(f"סניף {branch} לא קיים בבנק {bank}")
        # הסניף מודפס גם בטקסט ("סניף 647")
        h, w = gray.shape
        head = _tess(gray[: int(0.3 * h), : int(0.6 * w)], "heb+eng", "--psm 6")
        c["branch_in_header"] = bool(re.search(rf"(?<!\d){branch}(?!\d)", head))
        c["drawer_id_valid"] = drawer["id_valid"]
        if drawer["id"] and not drawer["id_valid"]:
            reasons.append("ת\"ז המושך לא עוברת ספרת ביקורת")
        if not drawer["id"]:
            reasons.append("ת\"ז המושך לא נקראה")

    # ציון ביטחון פשוט ושקוף
    score = 0.0
    if out["checks"].get("micr_matches_printed"):
        score += 0.6
    elif fields:
        score += 0.2
    if out["checks"].get("bank_known"):
        score += 0.1
    if out["checks"].get("branch_in_header"):
        score += 0.1
    if drawer["id_valid"]:
        score += 0.1
    if sharp >= MIN_SHARPNESS:
        score += 0.1
    out["confidence"] = round(score, 2)
    # מספרי השיק נכנסים רק אם שני מקורות הסכימו. כל השאר לבדיקה ידנית מוגברת.
    out["needs_review"] = bool(reasons)
    out["reasons"] = reasons
    out["status"] = "to_review"  # תמיד: הצוות מאשר ב"אשר והזן"

    if debug_dir:
        os.makedirs(debug_dir, exist_ok=True)
        dbg = check.copy()
        if micr:
            y0, y1 = micr["band"]
            for g in micr["glyphs"]:
                cv2.rectangle(dbg, (g.x0, y0), (g.x1, y1), (0, 0, 255), 2)
        cv2.imwrite(os.path.join(debug_dir, "check_aligned.jpg"), dbg)
    return out


def learn(path_or_img, truth_groups: list[str], templates: Templates | None = None) -> int:
    """מוסיף תבניות מצילום שאומת ידנית. truth_groups = [שיק, בנק, סניף, חשבון] כפי שמופיעים ב-MICR.
    מחזיר כמה תווים נלמדו (0 אם החלוקה לא תאמה)."""
    img = cv2.imread(path_or_img) if isinstance(path_or_img, str) else path_or_img
    templates = templates or Templates()
    gray = flatten_light(cv2.cvtColor(find_check(img)[0], cv2.COLOR_BGR2GRAY))
    for g in (gray, cv2.rotate(gray, cv2.ROTATE_180)):
        band = find_micr_band(g)
        if band is None:
            continue
        glyphs = segment_micr(g, band)
        digits = "".join(truth_groups)
        # מספר הסימנים = סך התאים פחות הספרות
        if len(glyphs) < len(digits) + len(truth_groups):
            continue
        # מיפוי: קבוצות ספרות מופרדות בסימנים. מזהים סימנים לפי מיקום: כל תא שאינו ספרה.
        labels = _align_labels(len(glyphs), truth_groups, glyphs)
        if labels is None:
            continue
        pitch = _pitch(glyphs)
        for gl, lab in zip(glyphs, labels):
            templates.add(glyph_vec(gl.img, pitch), lab)
        templates.save()
        return len(glyphs)
    return 0


def _align_labels(n, groups, glyphs):
    """מתאים תוויות לתאים: מחפשים רווחים גדולים בין תאים כגבולות קבוצה ומניחים סימנים בקצוות.
    מבנה ישראלי טיפוסי: S ddddddd  S dd S ddddd S  dddddddd S"""
    patterns = [
        ["S"] + list(groups[0]) + ["S"] + list(groups[1]) + ["S"] + list(groups[2]) + ["S"] + list(groups[3]) + ["S"],
        ["S"] + list(groups[0]) + ["S", "S"] + list(groups[1]) + ["S"] + list(groups[2]) + ["S"] + list(groups[3]) + ["S"],
    ]
    for p in patterns:
        if len(p) == n:
            return p
    return None


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    debug = None
    if "--debug" in argv:
        debug = argv[argv.index("--debug") + 1]
    res = analyze(argv[1], debug_dir=debug, branches=load_branches(os.environ.get("BRANCHES_CSV")))
    print(json.dumps(res, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
