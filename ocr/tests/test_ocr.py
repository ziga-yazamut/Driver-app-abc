"""בדיקות: קריאה נכונה בצילומי שטח מעוותים, ודגל "לבדיקה" בכל מקרה של ספק.

הכלל החשוב: אסור שתהיה תוצאה שגויה בלי needs_review=True.
"""
import os
import sys

import json

import cv2
import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import check_ocr as c  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
SAMPLES = os.path.join(HERE, "..", "samples")
# צילומי שיקים אמיתיים לא נשמרים ב-git (מידע אישי). שמים אותם ב-samples/ מקומית עם samples.json:
# [{"image": "leumi_1.jpg", "micr": ["<שיק>","<בנק>","<סניף+2>","<חשבון>"], "drawer_id": "<ת\"ז>"}]
_meta = os.path.join(SAMPLES, "samples.json")
if not os.path.exists(_meta):
    pytest.skip("אין צילומי שיקים ב-samples/ (לא נשמרים ב-git)", allow_module_level=True)
_s = json.load(open(_meta))[0]
SRC = cv2.imread(os.path.join(SAMPLES, _s["image"]))
_m = _s["micr"]
TRUTH = (_m[0], _m[1].zfill(2), _m[2][:3], _m[3], _s["drawer_id"])
T = c.Templates()


def rot(img, a):
    M = cv2.getRotationMatrix2D((img.shape[1] / 2, img.shape[0] / 2), a, 1)
    return cv2.warpAffine(img, M, (img.shape[1], img.shape[0]), borderValue=(40, 40, 40))


def persp(img, d):
    h, w = img.shape[:2]
    s = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    t = np.float32([[d * w, 0], [w, d * h], [w - d * w, h], [0, h - d * h]])
    return cv2.warpPerspective(img, cv2.getPerspectiveTransform(s, t), (w, h), borderValue=(40, 40, 40))


VARIANTS = {
    "original": lambda x: x,
    "rot90": lambda x: cv2.rotate(x, cv2.ROTATE_90_CLOCKWISE),
    "rot180": lambda x: cv2.rotate(x, cv2.ROTATE_180),
    "rot270": lambda x: cv2.rotate(x, cv2.ROTATE_90_COUNTERCLOCKWISE),
    "tilt+6": lambda x: rot(x, 6),
    "tilt-8": lambda x: rot(x, -8),
    "low_res": lambda x: cv2.resize(x, None, fx=.35, fy=.35, interpolation=cv2.INTER_AREA),
    "jpeg30": lambda x: cv2.imdecode(cv2.imencode(".jpg", x, [cv2.IMWRITE_JPEG_QUALITY, 30])[1], 1),
    "blur9": lambda x: cv2.GaussianBlur(x, (9, 9), 0),
    "blur15": lambda x: cv2.GaussianBlur(x, (15, 15), 0),
    "dark": lambda x: cv2.convertScaleAbs(x, alpha=.6),
    "overexposed": lambda x: cv2.convertScaleAbs(x, alpha=1.2, beta=30),
    "perspective": lambda x: persp(x, .06),
    "shadow": lambda x: (x * np.linspace(.45, 1, x.shape[1])[None, :, None]).astype(np.uint8),
}


@pytest.mark.parametrize("name", list(VARIANTS))
def test_never_silently_wrong(name):
    r = c.analyze(VARIANTS[name](SRC), templates=T)
    got = (r["check_no"], r["bank"], r["branch"], r["account"], r["drawer"]["id"])
    assert got == TRUTH or r["needs_review"], f"{name}: שגוי בלי דגל בדיקה {got}"


@pytest.mark.parametrize("name", ["original", "rot90", "rot180", "tilt+6", "jpeg30", "dark", "perspective", "shadow"])
def test_reads_clean_photos(name):
    r = c.analyze(VARIANTS[name](SRC), templates=T)
    assert (r["check_no"], r["bank"], r["branch"], r["account"]) == TRUTH[:4]
    assert r["checks"]["micr_matches_printed"]
    assert not r["needs_review"], r["reasons"]


def test_micr_tamper_flagged():
    base, _ = c.find_check(SRC)
    g = c.flatten_light(cv2.cvtColor(base, cv2.COLOR_BGR2GRAY))
    band = c.find_micr_band(g)
    gl = c.segment_micr(g, band)
    y0, y1 = band
    src, dst = gl[24], gl[25]          # ה-9 מועתק על ה-1 האחרון בחשבון
    wd = min(src.x1 - src.x0, dst.x1 - dst.x0)
    base[y0:y1, dst.x0:dst.x0 + wd + 4] = base[y0:y1, src.x0:src.x0 + wd + 4]
    r = c.analyze(cv2.copyMakeBorder(base, 120, 120, 120, 120, cv2.BORDER_CONSTANT, value=(35, 35, 35)), templates=T)
    assert r["needs_review"]
    assert not r["checks"]["micr_matches_printed"]


def test_sample_drawer_id_checksum():
    assert c.israeli_id_valid(TRUTH[4])
