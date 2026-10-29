# ABC Driver App

The driver's phone app for delivery day, plus a small office page. It is built like the ABC catalog: a static app and Netlify functions, with Supabase for the app's own data (results, photos).

**The app reads the main system (abcmobile), and writes nothing to it.** The driver opens the same link the main system already sends (`/d/<GUID>`, or `/DeliveryList/Single/<GUID>` on this site). Writing back stays off until `MAIN_WRITE=on` (see [Connecting the main system](#connecting-the-main-system)). `/office` is a view-only results page.

## What the driver does

The driver opens `/d/<GUID>` from WhatsApp. There is nothing to install, and the app switches between Hebrew and English.

1. **Start of day:** confirms three rules (checks, cash, packages).
2. **The list:** their deliveries for the day. They can drag ⋮⋮ to reorder them. The top strip shows the number of checks, the cash total and how many deliveries are done.
3. **Each delivery takes up to three steps:**
   - **Delivery and signature:** the number of boxes, a package photo, an optional receipt photo, the customer's signature and the receiver's name. Or "did not take it", with a reason.
   - **Payment:** only when there is something to collect. One or more lines, each a check (photo, number, bank, branch, account, due date), cash (photo) or credit (amount only). Collecting a different amount needs a reason.
   - **Returns:** optional photos and a note.
4. **Day summary:** what goes in the checks and cash envelopes, and which packages go back. **Close the day** works only when every delivery is done.

**No signal:** every step is kept on the phone (IndexedDB). A finished delivery waits in an outbox and sends itself when the signal returns, even after the phone or page restarts. Photos are shrunk on the phone before sending.

**Undo:** "My mistake, reopen" works for 10 minutes after finishing, and brings back the photos and signature.

## What the office does (`/office`)

The office page needs the office code (`ADMIN_CODE`). From it the office can:

- Create a list for a driver and a date, then add, edit or remove deliveries. A delivery that already has a result is locked.
- Copy the driver's link, or send it on WhatsApp.
- See each result: status and time, the receiver, boxes, payment lines with check details, the reason for any difference, returns, and every photo.

Photos are in a **private** bucket, because check photos carry bank details. They are shown only through links that expire after an hour.

The clickable mockup is still at `/mockup.html`.

## Setup (once)

1. **Supabase.** Use the catalog's project or a new one. Open SQL Editor → New query, paste `supabase/schema.sql` and click Run. It is safe to run again.
2. **Netlify:**
   1. Add new project → Import from Git → `ziga-yazamut/Driver-app-abc`. The build settings come from `netlify.toml`.
   2. Under Site configuration → Environment variables, add:

      | Variable | Where it comes from |
      |---|---|
      | `SUPABASE_URL` | Supabase → Project Settings → Data API → Project URL |
      | `SUPABASE_SECRET_KEY` | Supabase → Project Settings → API Keys → Secret key |
      | `ADMIN_CODE` | A code you choose, for `/office` |

   3. Deploys → Trigger deploy. New variables take effect only on the next deploy.

To check the setup, open `/api/status`. It shows which keys are set (yes or no only), where deliveries come from, and whether the tables exist.

**No key is stored in the code or the repository.**

## Connecting the main system

The app uses only the driver-link endpoints that abcmobile already has, in `MobileParts/Controllers/DeliveryListController.cs`. All of it is in `netlify/lib/abc.mjs`.

| Switch | What it does |
|---|---|
| `MAIN_READ` (on unless set to `off`) | Deliveries come from `GET /DeliveryList/GetModel/<GUID>`, the same GUID as the existing driver link. Read only. |
| `MAIN_WRITE=on` (off by default; ignored when `MAIN_READ=off`) | A finished delivery also goes to `FinalizeSignature` (signature, receiver name, package photo, amount paid), which **marks the customer's orders as Delivered**, and then to `SetCompleted`. The driver's order goes to `SetPositions`, the rules to `SetPreCheck` (1 = checks, 2 = packages), and "Close the day" to `NotifyOffice`, which sends a WhatsApp to the office. |

**Not in the main system yet**, so it stays in Supabase only:
- the payment method of each line
- check details and photos
- cash photos
- the reason for a difference
- boxes delivered
- "not delivered" and its reason
- returns (RMA)

**Known bug in abcmobile:** `FinalizeSignature` saves the receipt photo into `DeliveryPackagePhoto`, over the package photo. The app therefore sends the package photo only, and keeps the receipt in Supabase.

## Code

| Path | What it is |
|---|---|
| `public/index.html` | The driver app |
| `public/office.html` | The office page |
| `public/app.css` | Shared styles (also used by the mockup) |
| `netlify/functions/` | `list`, `day`, `photo`, `finish`, `undo`, `result`, `office`, `status` (each file's first lines describe it) |
| `netlify/lib/abc.mjs` | The main system: read and write, each behind its switch |
| `netlify/lib/source.mjs` | Where deliveries come from: `/office` or the main system |
| `netlify/lib/supa.mjs` | Supabase REST, copied from the catalog |
| `supabase/schema.sql` | The tables and the private photo bucket |
| `test/devserver.mjs` | A local stand-in for Netlify and Supabase |
| `mockup/` | The clickable mockup |
| `ocr/` | An earlier draft, not used |

## Running and testing locally

```bash
npm install
npm run dev     # http://localhost:8888/office (code: test). No accounts needed; data is kept in memory.
npm test        # the main-system client (node --test), then the app, office and mockup in Chromium (Playwright)
```
