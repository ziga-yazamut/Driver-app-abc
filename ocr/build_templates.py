"""בונה את ספריית התבניות e13b_templates.npz מצילומי שיקים שאומתו ידנית.

samples.json: [{"image": "check1.jpg", "micr": ["1000001","10","64731","01234567"]}, ...]
לכל צילום נלמדות גם גרסאות מעוותות קלות (הטיה, טשטוש, דחיסה) כדי שהתבנית תחזיק בצילומי שטח.
"""
import json, os, sys
import cv2, numpy as np
import check_ocr as c

def variants(img):
    yield img
    for a in (-3, 3):
        M = cv2.getRotationMatrix2D((img.shape[1] / 2, img.shape[0] / 2), a, 1)
        yield cv2.warpAffine(img, M, (img.shape[1], img.shape[0]), borderValue=(40, 40, 40))
    yield cv2.GaussianBlur(img, (5, 5), 0)
    yield cv2.imdecode(cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 50])[1], 1)
    yield cv2.resize(img, None, fx=0.6, fy=0.6, interpolation=cv2.INTER_AREA)

def main(path="samples.json"):
    samples = json.load(open(path))
    if os.path.exists(c.TEMPLATES_PATH):
        os.remove(c.TEMPLATES_PATH)
    T = c.Templates()
    for s in samples:
        img = cv2.imread(os.path.join(os.path.dirname(path) or ".", s["image"]))
        n = sum(c.learn(v, s["micr"], T) > 0 for v in variants(img))
        print(f"{s['image']}: {n} גרסאות נלמדו")
    print(f"סה\"כ {len(T.labels)} תבניות, ספרות: {''.join(sorted(set(T.labels) - {'S'}))}")

if __name__ == "__main__":
    main(*sys.argv[1:])
