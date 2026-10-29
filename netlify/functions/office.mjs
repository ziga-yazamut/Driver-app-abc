// The office page (/office). Every call needs the office code (ADMIN_CODE in Netlify).
// GET  /api/office?code=…                   the driver lists, newest first, with how many deliveries are done
// GET  /api/office?code=…&guid=…            one list: its deliveries and each result with photo links
// POST /api/office {code, op:'create', person, date}         a new driver list; returns its GUID (the link)
// POST /api/office {code, op:'sample', person}               a new list with 4 sample deliveries, to try the app
// POST /api/office {code, op:'add', guid, task}              add a delivery
// POST /api/office {code, op:'edit', id, task}               change a delivery that has no result yet
// POST /api/office {code, op:'remove', id}                   remove a delivery that has no result yet
// POST /api/office {code, op:'removeList', guid}             remove a list that has no results
// The office can type test lists also while the main system is read (MAIN_READ=on): both work side by side.
// Opening a main-system GUID here adds it to the lists.
import { json, handle } from '../lib/http.mjs';
import { select, insert, update, remove } from '../lib/supa.mjs';
import { readsOn, writesOn } from '../lib/abc.mjs';
import { getList } from '../lib/source.mjs';
import { validGuid, validId, withLinks, ensureList } from '../lib/driver.mjs';

const txt = (v, n = 200) => String(v ?? '').trim().slice(0, n);
const taskRow = t => ({
  company: txt(t.company, 120), city: txt(t.city, 60), address: txt(t.address, 160), phone: txt(t.phone, 30),
  total: Math.max(0, Math.round((Number(t.total) || 0) * 100) / 100), terms: txt(t.terms, 60),
  boxes: Math.max(1, Math.min(999, parseInt(t.boxes, 10) || 1)), comment: txt(t.comment, 300),
});
const SAMPLE = [
  { company: 'Sample customer A', city: 'Ra\'anana', address: '12 Herzl St.', phone: '050-0000001', total: 1250, terms: 'Check 45 days', boxes: 2 },
  { company: 'Sample customer B', city: 'Kfar Saba', address: '45 Weizmann St.', phone: '050-0000002', total: 890, terms: 'Cash', boxes: 1 },
  { company: 'Sample customer C', city: 'Hod HaSharon', address: '8 HaTa\'asiya St.', phone: '050-0000003', total: 0, terms: 'Prepaid', boxes: 3 },
  { company: 'Sample customer D', city: 'Herzliya', address: '3 HaYam St.', phone: '050-0000004', total: 3400, terms: 'Credit', boxes: 4 },
];
const today = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10); // Israel time, near enough for a date

async function allowed(code) {
  const want = process.env.ADMIN_CODE || '';
  if (want && code === want) return true;
  await new Promise(r => setTimeout(r, 1000)); // a wrong code waits a moment, so codes can't be guessed quickly
  return false;
}
const hasResults = async q => (await select('driver_results', `select=delivery_id&${q}&limit=1`, { pageSize: 1 })).length > 0;

export default handle(async req => {
  const url = new URL(req.url);
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const code = req.method === 'POST' ? body.code : url.searchParams.get('code');
  if (!process.env.ADMIN_CODE) return json({ error: 'not_configured', message: 'ADMIN_CODE is missing in Netlify environment variables' }, 503);
  if (!(await allowed(code))) return json({ error: 'forbidden' }, 403);
  const main = readsOn();

  if (req.method === 'GET') {
    const guid = url.searchParams.get('guid');
    if (guid) {
      if (!validGuid(guid)) return json({ error: 'bad_request' }, 400);
      const list = await getList(guid);
      if (!list) return json({ error: 'not_found' }, 404);
      if (list.master) return json({ master: true, people: list.people.map(p => ({ person: p.person, guid: p.guid, count: p.tasks.length })) }, 200, { 'Cache-Control': 'no-store' });
      if (list.from === 'main') await ensureList(list);
      const rows = list.tasks.length ? await select('driver_results', `select=*&delivery_id=in.(${list.tasks.map(t => t.id).join(',')})`) : [];
      const results = Object.fromEntries(await Promise.all(rows.map(async r => [r.delivery_id, await withLinks(r)])));
      const [day] = await select('driver_lists', `select=accepted_at,closed_at,order_ids&guid=eq.${guid}`);
      return json({ ...list, day: day || null, results, typing: list.from === 'office', main }, 200, { 'Cache-Control': 'no-store' });
    }
    const lists = await select('driver_lists', 'select=guid,person,list_date,accepted_at,closed_at,updated_at&order=updated_at.desc&limit=60', { pageSize: 60 });
    const guids = lists.map(l => l.guid);
    const [tasks, results] = guids.length ? await Promise.all([
      select('driver_tasks', `select=guid&guid=in.(${guids.join(',')})`),
      select('driver_results', `select=guid,status&guid=in.(${guids.join(',')})`),
    ]) : [[], []];
    const count = (a, g, f = () => true) => a.filter(x => x.guid === g && f(x)).length;
    return json({
      typing: true, main, mainWrite: writesOn(),
      lists: lists.map(l => ({ ...l, tasks: count(tasks, l.guid) || (main ? null : 0), delivered: count(results, l.guid, r => r.status === 'delivered'), failed: count(results, l.guid, r => r.status === 'not_delivered') })),
    }, 200, { 'Cache-Control': 'no-store' });
  }

  const { op } = body;
  if (op === 'create' || op === 'sample') {
    const person = txt(body.person, 60);
    if (!person) return json({ error: 'person_required' }, 400);
    const guid = crypto.randomUUID();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || '') ? body.date : today();
    await insert('driver_lists', { guid, person, list_date: date });
    if (op === 'sample') for (const [i, t] of SAMPLE.entries()) await insert('driver_tasks', { guid, position: i, ...taskRow(t) });
    return json({ ok: true, guid });
  }
  if (op === 'add') {
    if (!validGuid(body.guid) || !body.task?.company) return json({ error: 'bad_request' }, 400);
    if ((await getList(body.guid))?.from !== 'office') return json({ error: 'main_list', message: 'This list comes from the main system' }, 409);
    const n = (await select('driver_tasks', `select=id&guid=eq.${body.guid}`)).length;
    await insert('driver_tasks', { guid: body.guid, position: n, ...taskRow(body.task) });
    return json({ ok: true });
  }
  if (op === 'edit' || op === 'remove') {
    if (!validId(body.id)) return json({ error: 'bad_request' }, 400);
    if (await hasResults(`delivery_id=eq.${body.id}`)) return json({ error: 'has_result' }, 409);
    if (op === 'edit') {
      if (!body.task?.company) return json({ error: 'bad_request' }, 400);
      await update('driver_tasks', `id=eq.${body.id}`, taskRow(body.task));
    } else await remove('driver_tasks', `id=eq.${body.id}`);
    return json({ ok: true });
  }
  if (op === 'removeList') {
    if (!validGuid(body.guid)) return json({ error: 'bad_request' }, 400);
    if (await hasResults(`guid=eq.${body.guid}`)) return json({ error: 'has_result' }, 409);
    await remove('driver_lists', `guid=eq.${body.guid}`);
    return json({ ok: true });
  }
  return json({ error: 'bad_request' }, 400);
});

export const config = { path: '/api/office' };
