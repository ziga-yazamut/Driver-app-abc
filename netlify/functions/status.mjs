// GET /api/status: which main system the app uses (its only backend).
// GET /api/status?guid=<GUID>: also what the main system answers for that driver link (status and counts only, no data).
import { json } from '../lib/http.mjs';
import { base, GUID } from '../lib/abc.mjs';

export default async req => {
  const guid = new URL(req.url).searchParams.get('guid') || '';
  let main;
  if (GUID.test(guid)) {
    const t0 = Date.now();
    try {
      const res = await fetch(`${base()}/DeliveryList/GetModel/${guid}`, { headers: { Accept: 'application/json' } });
      const text = await res.text();
      let m = null; try { m = JSON.parse(text); } catch (e) {}
      main = { http: res.status, type: res.headers.get('content-type'), json: !!m, master: !!m?.IsMasterLink,
        tasks: m ? (m.IsMasterLink ? Object.values(m.PersonalModels || {}).reduce((a, p) => a + (p.Tasks || []).length, 0) : (m.Tasks || []).length) : null,
        ms: Date.now() - t0, start: m ? undefined : text.slice(0, 80).replace(/\s+/g, ' ') };
    } catch (e) { main = { error: e.message, cause: e.cause?.code || e.cause?.message, ms: Date.now() - t0 }; }
  }
  return json({ backend: base(), main }, 200, { 'Cache-Control': 'no-store' });
};

export const config = { path: '/api/status' };
