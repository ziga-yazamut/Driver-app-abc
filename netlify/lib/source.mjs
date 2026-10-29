// Where the driver's deliveries come from.
// A list the office typed in /office comes from Supabase. Any other GUID, with MAIN_READ=on, is read from the
// main system (abcmobile GetModel), so both work side by side. Office GUIDs are random and their delivery ids
// start at 1000000000, so they never meet the main system's.
import { select } from './supa.mjs';
import { readsOn, getMainList } from './abc.mjs';

export const source = () => readsOn() ? 'main' : 'office';

const fromRow = t => ({
  id: t.id, company: t.company, city: t.city, address: t.address, phone: t.phone,
  total: Number(t.total) || 0, paid: 0, due: Number(t.total) || 0, terms: t.terms, boxes: t.boxes,
  comment: t.comment, firstOrder: false, vat: '', position: t.position, completed: false, created: t.created_at,
});

export async function getOfficeList(guid) {
  const [day] = await select('driver_lists', `select=guid,person,list_date&guid=eq.${guid}`);
  if (!day) return null;
  const tasks = await select('driver_tasks', `select=*&guid=eq.${guid}&order=position.asc,id.asc`);
  return { guid, person: day.person || '', date: day.list_date || '', tasks: tasks.map(fromRow), from: 'office' };
}

export async function getList(guid) {
  const office = await getOfficeList(guid);
  if (office?.tasks.length || !readsOn()) return office;
  const main = await getMainList(guid);
  return main ? { ...main, from: 'main' } : office;
}
