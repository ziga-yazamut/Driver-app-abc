# Driver App ABC

A clickable **UI mockup** of the driver delivery app. It shows the screens and the flow we expect, nothing more.

Open [`mockup/index.html`](mockup/index.html) in a browser, or on a phone. Use the **EN / עב** switch at the top to change the language, and the **Driver / Main system** switch to change the view.

Next to the phone (below it on a phone) is a spec card for the current screen: what it shows, what the driver does, the rules, and what gets saved for the delivery. The **All screens** list jumps straight to any of the 7 screens. **Demo: skip required fields** is on by default so you can click through; turn it off to see the real validation.

## What the mockup shows

**Driver (phone):**
1. A start screen with three end-of-day rules. The deliveries appear only after the driver confirms them.
2. The list of today's deliveries, in the order the main system sent them. The driver can drag to reorder.
3. Each delivery is a 3-step wizard:
   - boxes, a delivery photo and the customer's signature
   - payment: one or more lines of check (photo), cash (photo) or credit (amount only)
   - an optional photo of returns
4. A strip at the top always shows the number of checks, the cash total and how many deliveries are done. An interim or day summary is always one tap away.

**Main system:** your existing deliveries table stays as it is and gets **two new columns** per delivery ID:
- **Delivery status**: on the way / delivered (with time) / not delivered (with reason). It links to the delivery page with the photos and signature.
- **Driver payment**: what the driver collected (check, cash or credit, one or more lines), marked "To review", with an **Approve** button that writes it into the existing payment rows. Empty until the delivery is done.

Everything in the mockup runs in the browser with sample data. Nothing is saved or sent anywhere, and check reading is faked.

## Scope

The developer owns the API, check reading and the backend (.NET). The mockup only defines the UI and the behavior.

`ocr/` is an earlier draft made without knowledge of the existing system. It is **not** a requirement, and it is fine to ignore or delete it.

## Mockup tests

```bash
npm install && npx playwright install chromium && npm run test:mockup
```

They cover every driver flow in both languages on a phone-sized screen.
