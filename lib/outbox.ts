// The phone's outbox: captures wait here, on the phone itself, until they have
// been uploaded. Nothing is lost if the page is closed or the signal drops.
import type { Capture, CaptureKind } from "./match";
import type { CaptureMeta } from "./survey-types";

export type Queued = {
  id: string;
  location_id: string;
  location_name: string;
  kind: CaptureKind;
  captured_at: string;
  fields: NonNullable<CaptureMeta["fields"]>;
  codes: string[];
  /** The shrunk photo. Dropped once the upload is confirmed. */
  bytes: ArrayBuffer | null;
  type: string;
  /** A tiny preview kept for the list. */
  thumb: string;
  state: "queued" | "sent" | "error";
  message: string;
  result: Capture | null;
  tries: number;
};

const DB_NAME = "fittings-capture";
const STORE = "outbox";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("storage unavailable"));
  });
}

async function tx<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = work(t.objectStore(STORE));
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error ?? new Error("storage failed"));
      t.onabort = () => reject(t.error ?? new Error("storage full"));
    });
  } finally {
    db.close();
  }
}

export const putItem = (item: Queued) => tx("readwrite", (s) => s.put(item)).then(() => undefined);
export const removeItem = (id: string) => tx("readwrite", (s) => s.delete(id)).then(() => undefined);

/** Everything in the outbox, newest first. */
export async function allItems(): Promise<Queued[]> {
  const items = await tx<Queued[]>("readonly", (s) => s.getAll());
  return items.sort((a, b) => b.captured_at.localeCompare(a.captured_at));
}

/** Keeps the list short: uploaded captures beyond the newest `keep` are forgotten on the phone. */
export async function pruneSent(keep = 60): Promise<void> {
  const sent = (await allItems()).filter((i) => i.state === "sent");
  for (const old of sent.slice(keep)) await removeItem(old.id);
}

/** Asks the browser not to clear this page's storage when the phone runs low on space. */
export async function keepStorage(): Promise<void> {
  try {
    await navigator.storage?.persist?.();
  } catch {
    /* not supported; the outbox still works */
  }
}

export function toMeta(item: Queued): CaptureMeta {
  return {
    id: item.id,
    location_id: item.location_id,
    location_name: item.location_name,
    kind: item.kind,
    captured_at: item.captured_at,
    codes: item.codes,
    fields: item.fields,
  };
}

export type SendResult = "sent" | "retry" | "error" | "auth";

/** Uploads one capture. "retry" means the signal or the server let us down and it stays queued. */
export async function sendItem(item: Queued): Promise<SendResult> {
  const form = new FormData();
  form.set("meta", JSON.stringify(toMeta(item)));
  if (item.bytes) form.set("photo", new Blob([item.bytes], { type: item.type }), "photo");
  let res: Response;
  try {
    res = await fetch("/api/capture", { method: "POST", body: form });
  } catch {
    return "retry";
  }
  if (res.status === 401) return "auth";
  const reply = (await res.json().catch(() => null)) as { ok?: boolean; capture?: Capture; message?: string } | null;
  if (res.ok && reply?.ok && reply.capture) {
    await putItem({ ...item, state: "sent", message: "", result: reply.capture, bytes: null });
    return "sent";
  }
  if (res.status >= 500 || res.status === 408 || res.status === 429) {
    await putItem({ ...item, tries: item.tries + 1 });
    return "retry";
  }
  await putItem({ ...item, state: "error", message: reply?.message ?? "This capture was not accepted." });
  return "error";
}
