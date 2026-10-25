// GET /api/list?guid=<GUID>: the driver's deliveries from the main system (read only),
// with what the app saved: the day (rules confirmed, the driver's order, day closed) and each finished delivery.
// A master link (several drivers) returns the drivers to pick from.
import { json, handle } from '../lib/http.mjs';
import { writesOn } from '../lib/abc.mjs';
import { getList, source } from '../lib/source.mjs';
import { validGuid, getDay, getResults, summary } from '../lib/driver.mjs';

export default handle(async req => {
  const guid = new URL(req.url).searchParams.get('guid') || '';
  if (!validGuid(guid)) return json({ error: 'bad_link' }, 400);
  const list = await getList(guid);
  if (!list) return json({ error: 'not_found' }, 404);
  if (list.master) return json({ master: true, people: list.people.map(p => ({ person: p.person, guid: p.guid, count: p.tasks.length })) });
  const [day, rows] = await Promise.all([getDay(guid), getResults(list.tasks.map(t => t.id))]);
  const results = Object.fromEntries(rows.map(r => [r.delivery_id, summary(r)]));
  return json({
    ...list,
    day: day ? { accepted_at: day.accepted_at, order: day.order_ids || [], closed_at: day.closed_at } : null,
    results,
    source: source(),
    writes: writesOn(),
  }, 200, { 'Cache-Control': 'no-store' });
});

export const config = { path: '/api/list' };
