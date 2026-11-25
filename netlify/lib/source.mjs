// Where the driver's deliveries come from: the main system (abcmobile GetModel), the app's only backend.
import { getMainList } from './abc.mjs';

export async function getList(guid) {
  const main = await getMainList(guid);
  return main ? { ...main, from: 'main' } : null;
}
