// POST /api/day {guid, action}
//   accept           the driver confirmed the start-of-day rules
//   order, ids       the driver's own order of the deliveries
//   close            "Close the day" (only when every delivery has a result)
// With MAIN_WRITE=on the same thing also goes to the existing endpoints (SetPreCheck, SetPositions, NotifyOffice).
import { json, handle } from '../lib/http.mjs';
import { update, log } from '../lib/supa.mjs';
import * as abc from '../lib/abc.mjs';
import { getList } from '../lib/source.mjs';
import { validGuid, ensureList, getResults } from '../lib/driver.mjs';

export default handle(async req => {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const { guid, action, ids } = await req.json().catch(() => ({}));
  if (!validGuid(guid)) return json({ error: 'bad_link' }, 400);
  const list = await getList(guid);
  if (!list || list.master) return json({ error: 'not_found' }, 404);
  await ensureList(list);
  const now = new Date().toISOString(), q = `guid=eq.${guid}`;
  let main = { skipped: true };
  // Lists typed in /office never go to the main system
  const skip = async () => ({ skipped: true });
  const { setPreCheck, setPositions, notifyOffice } = list.from === 'main' ? abc : { setPreCheck: skip, setPositions: skip, notifyOffice: skip };

  if (action === 'accept') {
    await update('driver_lists', q, { accepted_at: now, updated_at: now });
    // The main system has two confirmations: 1 = checks, 2 = packages
    const a = await setPreCheck(guid, 1, true), b = await setPreCheck(guid, 2, true);
    main = a.skipped ? a : { ok: a.ok && b.ok };
  } else if (action === 'order') {
    const known = new Set(list.tasks.map(t => t.id));
    if (!Array.isArray(ids) || !ids.every(id => known.has(id))) return json({ error: 'bad_request' }, 400);
    await update('driver_lists', q, { order_ids: ids, updated_at: now });
    main = await setPositions(guid, ids);
  } else if (action === 'close') {
    const done = new Set((await getResults(list.tasks.map(t => t.id))).map(r => r.delivery_id));
    const open = list.tasks.filter(t => !t.completed && !done.has(t.id)).length;
    if (open) return json({ error: 'open_deliveries', open }, 409);
    await update('driver_lists', q, { closed_at: now, updated_at: now });
    main = await notifyOffice(guid);
  } else return json({ error: 'bad_request' }, 400);

  if (!main.skipped) await log('main_' + action, !!main.ok, { guid, status: main.status, text: main.text });
  return json({ ok: true, at: now, main: main.skipped ? 'off' : main.ok ? 'sent' : 'failed' });
});

export const config = { path: '/api/day' };
