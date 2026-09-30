# Driver App ABC

A delivery app for drivers that plugs into our existing main system by **delivery ID**.

## The idea in one minute

1. The main system already creates a unique ID for every delivery. It sends the driver's deliveries to this app.
2. The driver gets a link. For each delivery the driver:
   - confirms the boxes
   - takes a delivery photo and gets the customer's signature
   - records the payment: check (photo, with OCR), cash (photo) or credit (just the amount)
   - optionally photographs returns
3. **One new column in the main system, "Delivery", gets everything back for each ID:**

| When | What the "Delivery" column shows |
|---|---|
| Sent to the driver | A link to the delivery page, labeled "On the way" |
| Driver closes the delivery | "Delivered" or "Not delivered" (same link) |
| Payment was collected | The payment summary, marked **"To review"**, and an **"Approve"** button |

4. Clicking **Approve** writes the payment into the **existing payment rows**. Nothing touches the payment rows before that, because check details come from OCR and a person checks them first.

The same link works for the driver and the office. The office never opens the driver app.

## What to build

1. **Server:** implements [`api/openapi.yaml`](api/openapi.yaml).
   - database
   - photo storage
   - tokenized links
   - an outbound queue to the main system: retries, idempotent by `delivery_id` + `revision`, read-back check, alert on failure
2. **Driver app (PWA):** follow [`mockup/index.html`](mockup/index.html). It must work offline and sync when the signal is back.
3. **Main system integration**, through its official API only:
   - read the deliveries
   - write the "Delivery" column
   - on Approve, create the payment rows
4. **Check OCR:** already written in [`ocr/`](ocr/README.md) (Python + FastAPI). Run it on our server and calibrate it on 20–30 real check photos.

## What's in the repo

| Path | What |
|---|---|
| `mockup/index.html` | Clickable mockup, one file. Open it in a browser. The second tab ("מה חוזר למערכת הראשית") shows the column. |
| `api/openapi.yaml` | API spec. The webhook schema matches exactly what the mockup sends; a test checks this. |
| `ocr/` | Check OCR, service and tests |
| `docs/` | Full plan and test report (Hebrew) |

## Tests

```bash
# mockup + API contract (Playwright)
npm install && npx playwright install chromium && npm run test:mockup

# OCR (needs tesseract-ocr + tesseract-ocr-heb)
cd ocr && pip install -r requirements.txt && pytest
```

GitHub Actions runs both on every push (`.github/workflows/tests.yml`).

## Open questions (need an answer before building)

- How do we read from and write to the main system: an API, file import, or something else?
- Where does the delivery-to-driver assignment come from today?
- In the MICR line, what does the "31" after the branch mean (`647` + `31`)?

## Privacy

Real check photos are never committed: they contain the drawer's name, ID and account. Put them in `ocr/samples/`, which is git-ignored. All numbers in the docs are placeholders.
