// Ausgang für Rückmeldungen und Fotos, die (noch) nicht hochgeladen werden konnten.
// Gespeichert nur auf diesem Gerät (IndexedDB); hochgeladen wird später nach inbox/app/.
// Ohne DOM – flush() und isNetworkError() sind mit node testbar (Speicher austauschbar).

const DB = "fitnesshelper";
const STORE = "outbox";

/** Netz-/Zeitfehler (kein Empfang) – im Gegensatz zu Fehlern wie 401/403, die Warten nicht löst. */
export function isNetworkError(e, online = true) {
  if (!online) return true;
  const n = e && e.name;
  return n === "TypeError" || n === "AbortError" || n === "TimeoutError" || n === "NetworkError";
}

/** Speicher im Arbeitsspeicher (Tests und Rückfall, wenn IndexedDB fehlt). */
export function memoryStore() {
  const m = new Map();
  let seq = 0;
  return {
    persistent: false,
    async add(item) { const id = `${Date.now()}-${++seq}`; m.set(id, { ...item, id }); return id; },
    async all() { return [...m.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)); },
    async remove(id) { m.delete(id); },
    async update(item) { m.set(item.id, item); },
  };
}

function req(r) {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

/** IndexedDB-Speicher; fällt auf den Arbeitsspeicher zurück, wenn IndexedDB nicht geht. */
export async function openStore(idb = globalThis.indexedDB) {
  if (!idb) return memoryStore();
  try {
    const open = idb.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE, { keyPath: "id" });
    const db = await req(open);
    const tx = (mode) => db.transaction(STORE, mode).objectStore(STORE);
    let seq = 0;
    return {
      persistent: true,
      async add(item) { const id = `${Date.now()}-${++seq}`; await req(tx("readwrite").put({ ...item, id })); return id; },
      async all() {
        const items = await req(tx("readonly").getAll());
        return items.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
      },
      async remove(id) { await req(tx("readwrite").delete(id)); },
      async update(item) { await req(tx("readwrite").put(item)); },
    };
  } catch {
    return memoryStore();
  }
}

/**
 * Lädt alles im Ausgang hoch, ältestes zuerst. send(item) wirft bei Fehlern.
 * Bei Netzfehler wird abgebrochen (später erneut); andere Fehler werden am Eintrag vermerkt
 * und der nächste versucht. Liefert { sent, left, error }.
 */
export async function flush(store, send, online = true) {
  const items = await store.all();
  let sent = 0, error = null;
  for (const item of items) {
    try {
      await send(item);
      await store.remove(item.id);
      sent++;
    } catch (e) {
      error = e;
      if (isNetworkError(e, online)) break;
      await store.update({ ...item, attempts: (item.attempts || 0) + 1, last_error: String(e.message || e) });
    }
  }
  const left = (await store.all()).length;
  return { sent, left, error };
}

/** Kurzbeschreibung für den Hinweis: „3 Fotos, 1 Rückmeldung“. */
export function summarize(items) {
  const photos = items.filter((i) => i.kind === "photo").length;
  const other = items.filter((i) => i.kind === "json" && !i.path.startsWith("inbox/app/photos/")).length;
  const parts = [];
  if (photos) parts.push(`${photos} ${photos === 1 ? "Foto" : "Fotos"}`);
  if (other) parts.push(`${other} ${other === 1 ? "Rückmeldung" : "Rückmeldungen"}`);
  return parts.join(", ");
}
