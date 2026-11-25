# Disabled: the /office page and the Supabase backend

The main system (abcmobile.shop) is the driver app's only backend. What used Supabase is kept here, unused:

| File | What it was |
|---|---|
| `office.html` | The `/office` page (was `public/office.html`) |
| `office.mjs` | Its API, `/api/office` (was `netlify/functions/office.mjs`) |
| `photo.mjs` | `/api/photo`, photo upload to the Supabase bucket (was `netlify/functions/photo.mjs`) |
| `office-lib.mjs` | The Supabase helpers the driver functions used to share (from `netlify/lib/driver.mjs` and `source.mjs`) |
| `supa.mjs` | The Supabase client (was `netlify/lib/supa.mjs`) |

None of it is deployed: Netlify publishes only `public/` and deploys only `netlify/functions/`.

## Turning /office back on

1. Move `office.html` back to `public/`, and `office.mjs` to `netlify/functions/` (its imports then point to `../disabled/`: change `./supa.mjs` and `./office-lib.mjs` to `../disabled/...`).
2. Add the redirect back to `netlify.toml`:
   ```toml
   [[redirects]]
     from = "/office"
     to = "/office.html"
     status = 200
   ```
3. It needs `SUPABASE_URL`, `SUPABASE_SECRET_KEY` and `ADMIN_CODE` in the Netlify environment.

Note: it shows results the old app saved in Supabase. Results saved by the current app are in the main system (`#/Deliveries` there).
