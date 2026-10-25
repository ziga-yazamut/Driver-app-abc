// Where the driver's deliveries come from.
// MAIN_READ=on: the main system (abcmobile GetModel). Otherwise: the lists the office typed in /office.
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
  return { guid, person: day.person || '', date: day.list_date || '', tasks: tasks.map(fromRow) };
}

export const getList = guid => readsOn() ? getMainList(guid) : getOfficeList(guid);
