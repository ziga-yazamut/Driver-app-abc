// POST /api/day {guid, action}: saved in the main system only (no Supabase).
//   accept           the driver confirmed the start-of-day rules   -> SetPreCheck 1, 2 and 3 (one per rule)
//   order, ids       the driver's own order of the deliveries      -> SetPositions
//   close            "Close the day"                               -> NotifyOffice (DayClosed, WhatsApp to the office)
// The app lets the driver close the day only when every delivery is done.
import { json, handle } from '../lib/http.mjs';
import { setPreCheck, setPositions, notifyOffice } from '../lib/abc.mjs';
import { getList } from '../lib/source.mjs';
import { validGuid } from '../lib/driver.mjs';

export default handle(async req => {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const { guid, action, ids } = await req.json().catch(() => ({}));
  if (!validGuid(guid)) return json({ error: 'bad_link' }, 400);
  const list = await getList(guid);
  if (!list || list.master) return json({ error: 'not_found' }, 404);

  let main;
  if (action === 'accept') {
    for (const n of [1, 2, 3]) { main = await setPreCheck(guid, n, true); if (!main.ok) break; }
  } else if (action === 'order') {
    const known = new Set(list.tasks.map(t => t.id));
    if (!Array.isArray(ids) || !ids.every(id => known.has(id))) return json({ error: 'bad_request' }, 400);
    main = await setPositions(guid, ids);
  } else if (action === 'close') {
    main = await notifyOffice(guid);
  } else return json({ error: 'bad_request' }, 400);

  if (!main.ok) {
    console.error(`main ${action} failed`, main.status, main.text);
    return json({ error: 'main_failed', message: `${main.status} ${main.text}`.trim() }, 502);
  }
  return json({ ok: true, at: new Date().toISOString(), main: 'sent' });
});

export const config = { path: '/api/day' };
