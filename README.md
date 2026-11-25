# ABC Driver App

The driver's phone app for delivery day. It is a static app and Netlify functions.

**The main system (abcmobile.shop) is the app's only backend:** everything is read from it and saved to it. The driver opens the same link the main system already sends (`/d/<GUID>`, or `/DeliveryList/Single/<GUID>` on this site). The office sees the results in the main system (`#/Deliveries`).

## What the driver does

The driver opens `/d/<GUID>` from WhatsApp. There is nothing to install, and the app switches between Hebrew and English.

1. **Start of day:** confirms three rules (checks, cash, packages).
2. **The list:** their deliveries for the day. They can drag ⋮⋮ to reorder them. The top strip shows the number of checks, the cash total and how many deliveries are done.
3. **Each delivery takes up to three steps:**
   - **Delivery and signature:** the number of boxes, a package photo, an optional receipt photo, the customer's signature and the receiver's name. Or "did not take it", with a reason.
   - **Payment:** always shown; with nothing to collect it can be skipped. One or more lines, each a check (photo, number, bank, branch, account, due date), cash (photo) or credit (amount only). Collecting a different amount needs a reason.
   - **Returns:** optional photos and a note.
4. **Day summary:** what goes in the checks and cash envelopes, and which packages go back. **Close the day** works only when every delivery is done.

**No signal:** every step is kept on the phone (IndexedDB). A finished delivery waits in an outbox and sends itself when the signal returns, even after the phone or page restarts. Photos are shrunk on the phone before sending.

**Undo:** "My mistake, reopen" works for 10 minutes after finishing, and brings back the photos and signature.

The `/office` page (lists typed by hand, results in Supabase) is **disabled**: its code is kept, not deployed, in `netlify/disabled/` (see the README there for how to turn it back on).

The clickable mockup is still at `/mockup.html`.

## Setup (once)

1. Netlify: Add new project → Import from Git → `ziga-yazamut/Driver-app-abc`. The build settings come from `netlify.toml`. No environment variables are needed.
2. The main system must have the driver-app endpoints and columns below (deploy the abcmobile changes first).

To check the connection, open `/api/status?guid=<GUID>`. It shows the main system's address and what it answers for that link (counts only).

## The main system

The app uses the driver-link endpoints in abcmobile's `MobileParts/Controllers/DeliveryListController.cs`. All of it is in `netlify/lib/abc.mjs`; its address is `MAIN_URL` there (`MAIN_URL_OVERRIDE` in the environment wins over it, e.g. `http://localhost:48289` for a local copy). There is no switch to stop reading or writing: everything the driver does changes real data in the main system.

| | What |
|---|---|
| Reading | Deliveries come from `GET /DeliveryList/GetModel/<GUID>`, the same GUID as the existing driver link. It also gives the start-of-day rules (`PreCheck1`-`3`), the day closed (`DayClosed`) and, in `Results`, everything saved for each delivery with its payments; the app shows finished stops from it and fills a reopened stop's steps from it. |
| Writing | A delivered stop goes to `ConfirmPackage`, then `FinalizeDelivery`, then `SetCompleted`. A stop that was not delivered goes to `FinalizeDelivery`, then `SetCompleted` (`FailedDelivery` tells them apart). The driver's order goes to `SetPositions`, the three rules to `SetPreCheck` 1-3, "Reopen" to `ReopenDelivery`, and "Close the day" to `NotifyOffice`, which sets `DayClosed` and sends a WhatsApp to the office. |

`FinalizeDelivery` (the app never calls `FinalizeSignature`, which stays as it is for the old driver page):
- calls `FinalizeSignature` for a delivered stop: signature, receiver name, package photo, receipt photo, amount paid (= the sum of the driver's payment lines). This **marks the customer's orders as Delivered**.
- saves each payment in `PaymentsCustomersWeek` with `DeliveryGUIDId` (which also marks it as coming from the driver app), `MethodType` `CHECK`, `CASH` or `CC`, and `Approved = false` when it is new or its details changed. The check or cash photo is saved as `/DeliverySignatures/DeliverySignature_ChequePicture<n>_<id>.jpg` or `..._CashPicture<n>_<id>.jpg` (in `PaymentPhoto`). The check's account number, holder name and holder ID have no columns and go into `Comment` (`Account 1, Holder X, Holder ID 2`).
- saves `BoxDelivered`, `DifferenceReason`, `FailedDelivery`, `FailedDeliveryReason`, `ReturnComment` and the returns photo (`/DeliverySignatures/Returns/ReturnPicture_<id>.jpg`, in `ReturnPhoto`) in `DeliveryGuids`.
- finishing the same delivery again (a retry, or after "Reopen") updates instead of adding: the delivery's payments are matched to the ones sent (by `paymentId`, else in order) and updated, new ones are added, and the delivery's payments that were not sent are deleted. A photo that is not sent keeps the saved one.

`ReopenDelivery` ("My mistake, reopen"): the delivery is no longer completed and the day no longer closed. Nothing is deleted. The app fills the steps from what was saved; a reopened stop keeps its saved signature and photos unless the driver replaces them.

The app takes one photo of each kind per delivery (package, receipt, returns, one per payment line). On the phone, every photo is made to fit 1600x1600 (only made smaller, never larger) and saved as JPEG at 80% (`IMG_MAX` and `IMG_QUALITY` in `public/index.html`), when it's taken and again right before sending. The app sends `noResize: true`, so the main system saves the photos exactly as received (`SaveImage(..., NoResize: true)`) instead of resizing them to 1920 px and saving them again; the old driver page doesn't send it and is unchanged. The signature is not changed: it is sent as drawn, as PNG, and the main system saves it as it is.

## Code

| Path | What it is |
|---|---|
| `public/index.html` | The driver app |
| `public/app.css` | Shared styles (also used by the mockup) |
| `netlify/functions/` | `list`, `day`, `finish`, `undo`, `result`, `status` (each file's first lines describe it) |
| `netlify/lib/abc.mjs` | The main system: its address, reading and writing |
| `netlify/lib/source.mjs` | The driver's list from the main system |
| `netlify/disabled/` | Not deployed: the `/office` page and API, `/api/photo` and the Supabase client |
| `supabase/schema.sql` | The Supabase tables the disabled `/office` page used |
| `test/devserver.mjs` | A local stand-in for Netlify and a fake main system (in memory), for the tests and `npm run dev` |
| `mockup/` | The clickable mockup |
| `ocr/` | An earlier draft, not used |

## Running and testing locally

```bash
npm install
npm run dev             # the app against a fake main system, no account and no real data:
                        #   POST http://localhost:8888/test/new-list for a list, then open /d/<GUID>
netlify dev --offline   # the app against MAIN_URL (the live abcmobile.shop: REAL data!) or MAIN_URL_OVERRIDE
npm test                # node --test (the main-system client), then Playwright: the app against the fake main system, and the mockup
```

Playwright needs Chromium (`npx playwright install chromium`), or point it at an installed Chrome:
`CHROMIUM_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe" npm test`.
