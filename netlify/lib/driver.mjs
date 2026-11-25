// Shared by the driver functions: checking the link and finding the delivery in the main system.
import { GUID } from './abc.mjs';
import { getList } from './source.mjs';

export const REASONS = ['absent', 'refused', 'address', 'damaged'];
export const PAY_TYPES = ['check', 'cash', 'credit'];

export const validGuid = g => typeof g === 'string' && GUID.test(g);
export const validId = id => Number.isInteger(id) && id > 0;

// The driver's list from the main system, and the delivery inside it (null when the id is not on this link)
export async function taskOf(guid, id) {
  const list = await getList(guid);
  if (!list || list.master) return { list, task: null };
  return { list, task: list.tasks.find(t => t.id === id) || null };
}
