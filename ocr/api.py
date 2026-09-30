"""שירות HTTP ל-OCR שיקים.

הרצה:  uvicorn api:app --host 0.0.0.0 --port 8080
"""
from datetime import date, timedelta
import os

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile

import check_ocr as c

app = FastAPI(title="Check OCR")
TEMPLATES = c.Templates()
BRANCHES = c.load_branches(os.environ.get("BRANCHES_CSV"))


def _decode(data: bytes):
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(400, "קובץ תמונה לא תקין")
    return img


@app.post("/ocr/check")
async def ocr_check(
    photo: UploadFile = File(...),
    customer_tax_id: str | None = Form(None),   # ח.פ./ת"ז של הלקוח מהמערכת הראשית
    due_date: date | None = Form(None),          # תאריך פירעון שהנהג הקליד
    check_terms_days: int | None = Form(None),   # תנאי תשלום של הלקוח
):
    res = c.analyze(_decode(await photo.read()), templates=TEMPLATES, branches=BRANCHES)
    warnings = []
    drawer_id = res["drawer"]["id"]
    if customer_tax_id and drawer_id and drawer_id.lstrip("0") != customer_tax_id.lstrip("0"):
        warnings.append("שיק צד ג': המושך אינו הלקוח")
    if due_date and check_terms_days is not None and due_date > date.today() + timedelta(days=check_terms_days):
        warnings.append(f"תאריך הפירעון מעבר ל-{check_terms_days} ימים")
    res["warnings"] = warnings
    # כפילות (אותו בנק+סניף+חשבון+מס' שיק כבר נסרק) נבדקת בשרת מול בסיס הנתונים
    return res


@app.post("/ocr/learn")
async def ocr_learn(
    photo: UploadFile = File(...),
    check_no: str = Form(...), bank: str = Form(...), branch_field: str = Form(...), account: str = Form(...),
):
    """נקרא כשהצוות אישר שיק ("אשר והזן") ותיקן ערכים: מוסיף את התווים לספריית התבניות."""
    n = c.learn(_decode(await photo.read()), [check_no, bank, branch_field, account], TEMPLATES)
    return {"learned_glyphs": n}


@app.get("/health")
def health():
    return {"ok": True, "templates": len(TEMPLATES.labels)}
