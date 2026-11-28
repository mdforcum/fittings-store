// Loads shelf spots for the bin label pages. Server only.
import type { SupabaseClient } from "@supabase/supabase-js";
import { binLabels, type BinLabel } from "./bin-labels";
import { spotName, type Spot } from "./shelf";

type Row = Spot & { location_id?: string | null };
export type LabelData = { labels: BinLabel[]; tops: Array<{ id: string; name: string }>; problem?: string };

/**
 * Every spot's label. With `locations`, only the shelf maps of those store
 * locations (a dealer's own). The location link on a top spot came with
 * supabase/add-space-map-locations.sql; without it a dealer has nothing to print.
 */
export async function loadBinLabels(db: SupabaseClient, locations?: string[]): Promise<LabelData> {
  let rows: Row[] = [];
  const full = await db.from("fittings_shelf_spots").select("id, parent_id, level, code, label, sort, location_id").limit(20000);
  if (full.error) {
    if (locations) return { labels: [], tops: [], problem: "Shelf maps for dealer locations aren't set up yet. Email Backroad Iron." };
    const plain = await db.from("fittings_shelf_spots").select("id, parent_id, level, code, label, sort").limit(20000);
    if (plain.error) return { labels: [], tops: [], problem: "Shelf spots are not set up yet: run supabase/add-shelf-spots.sql on the database." };
    rows = (plain.data ?? []) as Row[];
  } else rows = (full.data ?? []) as Row[];
  const topRows = rows.filter((r) => !r.parent_id && (!locations || (r.location_id != null && locations.includes(r.location_id))));
  const allowed = locations ? new Set(topRows.map((r) => r.id)) : undefined;
  const labels = binLabels(rows, allowed);
  const used = new Set(labels.map((l) => l.top));
  return { labels, tops: topRows.filter((t) => used.has(t.id)).map((t) => ({ id: t.id, name: `${spotName(t)} (${t.code})` })) };
}
