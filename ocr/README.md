# Check OCR

Reads an Israeli check from the driver's photo. It returns the check number, bank, branch, account, and the drawer's name and ID.

The amount and the date are handwritten, so they are **not** read. The driver types the date, and the amount comes from the order.

## How it works

1. **Find the check** in the photo, fix perspective, and rotate to landscape. Any rotation works, upside-down included.
2. **Read the MICR line** (the magnetic digits at the bottom). Each character is cut out by its fixed pitch and matched against E-13B templates (`e13b_templates.npz`). Plain Tesseract reads this font badly, so there is a small dedicated classifier.
3. **Read the printed top line** (e.g. `1000001 10 64731 01234567`), which holds the same numbers in a normal font, using Tesseract.
4. **Cross-check:** the numbers count as certain only if both readings match. Otherwise the result gets `needs_review: true` with the reason.
5. **Extra checks:**
   - bank code is known
   - the branch number also appears in the check header
   - the drawer ID passes its check digit
   - the photo is sharp enough and the check is not too small
   - optionally, the branch is in the Bank of Israel list (`BRANCHES_CSV=bank,branch` file)

**Rule:** the module must never return a wrong number without `needs_review: true`. On top of that, every payment enters the main system as "to review" until someone clicks Approve.

## Install and run

```bash
sudo apt-get install -y tesseract-ocr tesseract-ocr-heb
pip install -r requirements.txt

python check_ocr.py photo.jpg             # prints JSON
python check_ocr.py photo.jpg --debug d/  # saves the aligned check with the MICR boxes
uvicorn api:app --port 8080               # HTTP service
```

### `POST /ocr/check` (multipart)

| Field | Required | Notes |
|---|---|---|
| `photo` | yes | the check photo |
| `customer_tax_id` | no | adds a "third-party check" warning when the drawer is not the customer |
| `due_date` | no | with `check_terms_days`, adds a "due date beyond terms" warning |
| `check_terms_days` | no | the customer's check terms |

Example response (placeholder numbers):

```json
{
  "check_no": "1000001", "bank": "10", "bank_name": "בנק לאומי",
  "branch": "647", "branch_field": "64731", "account": "01234567",
  "drawer": {"name": "ישראל ישראלי", "id": "123456782", "id_valid": true, "phone": "050-0000000"},
  "amount": null, "due_date": null,
  "sources": {"micr": "S1000001S10S64731S01234567S", "printed_line": "1000001 10 64731 01234567"},
  "checks": {"micr_matches_printed": true, "bank_known": true, "branch_in_header": true, "drawer_id_valid": true},
  "confidence": 1.0, "needs_review": false, "reasons": [], "status": "to_review", "warnings": []
}
```

### `POST /ocr/learn`

Call this after staff approve a check. The fields are `photo`, `check_no`, `bank`, `branch_field` and `account`. It adds that check's characters to the templates, so reading improves over time.

**Duplicates** (same bank, branch, account and check number already scanned) are checked by the server against its database.

## Tests

```bash
pytest -q                      # all tests
python tests/stress.py 300     # large random run, prints a summary
```

- **`tests/test_synthetic.py`** runs in CI with no real photos. `tests/synth.py` builds fake checks with random numbers and banks, then distorts them like phone photos:
  - rotation and tilt
  - perspective
  - shadow
  - blur
  - JPEG compression

  It also covers these cases, which must all be flagged:
  - an unknown digit (8)
  - the top line disagreeing with the MICR
  - a missing top line
  - an invalid drawer ID
  - an unknown bank
  - a branch not in the list
  - no check in the photo
- **`tests/test_ocr.py`** runs on real photos in `samples/`, if present. They are git-ignored.

**Limits:**
- The templates come from one real check. The synthetic checks use the same character shapes, so these tests prove the pipeline, not accuracy on other banks' print.
- Before going live, add 20–30 real checks from different banks to `samples/samples.json` and run `python build_templates.py samples/samples.json`.
- The digit **8** is not learned yet, so any check containing an 8 is flagged until one is added.
- Some banks may not print the top line. Those checks have a single source and are always flagged.
- The drawer name and address come from Hebrew Tesseract and may have small errors. They are for display only; the ID (which has a check digit) is what's validated.
- The "31" in the branch field (`64731`) is kept as-is in `branch_field`; its meaning is unknown.

## Files

| File | What |
|---|---|
| `check_ocr.py` | the module and its CLI |
| `api.py` | FastAPI service |
| `build_templates.py` | builds the templates from verified photos |
| `e13b_templates.npz` | the templates |
| `samples/` | real verified photos and `samples.json` (git-ignored) |
| `tests/` | tests, the synthetic check generator, the stress run |
