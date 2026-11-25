// Shapes shared by the survey API, the phone capture page and the back-office screens.
import type { Capture, Survey } from "./match";

export type Location = { id: string; name: string; captures: number };

/** A store catalog item that carries the same part number as a surveyed part. */
export type StoreMatch = { id: string; name: string; qty: number; photos: number };

export type SurveyData = {
  locations: Location[];
  location_id: string | null;
  captures: Capture[];
  survey: Survey;
  /** Keyed by normalized part number. */
  store: Record<string, StoreMatch>;
  /** False until ANTHROPIC_API_KEY is set: photos upload but are not read. */
  reading: boolean;
};

export type SurveyReply =
  | { ok: true; data: SurveyData; result?: Record<string, unknown> }
  | { ok: false; message: string };

/** What the phone sends with each capture. */
export type CaptureMeta = {
  id: string;
  location_id: string;
  location_name?: string;
  kind: Capture["kind"];
  captured_at: string;
  codes?: string[];
  fields?: Partial<
    Pick<Capture, "part_number" | "upc" | "description" | "aisle" | "bin" | "qty_on_card" | "count_seen" | "notes">
  >;
};

export type CaptureReply = { ok: true; capture: Capture } | { ok: false; message: string };

export type SupplierJob =
  | { t: "listing"; url: string; tries?: number }
  | { t: "page"; url: string; product_id: string; tries?: number }
  | { t: "image"; image_url: string; page_url: string; product_id: string; tries?: number };

export type SupplierProduct = {
  id: string;
  name: string;
  part_number: string;
  own_photos: number;
  found: { part_number: string; name: string; page_url: string; image_url: string } | null;
  imported: Array<{ id: string; published: boolean; preview_url: string; page_url: string }>;
  queued: boolean;
};

export type SupplierData = {
  source: { id: string; name: string; host: string };
  permission: boolean;
  permission_note: string;
  permission_at: string | null;
  listings: string[];
  index_count: number;
  scanned_at: string | null;
  queue: number;
  /** Seconds until the supplier's crawl delay lets the next request go. */
  wait: number;
  crawl_delay: number | null;
  last_error: string;
  products: SupplierProduct[];
};

export type SupplierReply =
  | { ok: true; data: SupplierData; result?: Record<string, unknown> }
  | { ok: false; message: string };
