"use client";
import { useEffect, useRef, useState } from "react";
import type { AdminData, Cost, StockMove } from "@/lib/admin-types";
import { NO_PLACES, countsLine, type Places } from "@/lib/places";
import { LocationForm } from "./Locations";
import {
  TYPES,
  adminStatus,
  dollars,
  marginFrom,
  money,
  photoUrl,
  specLine,
  toCents,
  type Product,
} from "@/lib/catalog";
import type { Act, Say } from "../Admin";
import { Modal, Picture } from "../ui";
import DetailsEditor from "./Details";
import ImportStock from "./ImportStock";
import PartFinder from "../PartFinder";
import { EMPTY_INDEX, smartSearch, type LookupBin, type LookupIndex, type PhotoRead } from "@/lib/lookup";

type Props = { data: AdminData; act: Act; say: Say; reload: () => Promise<void> };
type Filter = "all" | "live" | "out" | "noprice";

const blurOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
  if (e.key === "Enter") e.currentTarget.blur();
};

export default function Inventory({ data, act, say, reload }: Props) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [editing, setEditing] = useState<string | null>(null); // product id, "new", or null
  const [stockOf, setStockOf] = useState<string | null>(null); // product id whose stock history is open
  const [bulk, setBulk] = useState("");
  // Finding by scan, UPC, bin or photo: the cross-reference index, the bin last scanned, the part last picked.
  const [index, setIndex] = useState<LookupIndex>(EMPTY_INDEX);
  const [bin, setBin] = useState<LookupBin | null>(null);
  const [picked, setPicked] = useState("");
  const [scanned, setScanned] = useState(false); // the stock panel was opened by a scan or an exact match
  const opsReady = !!data.ops?.ready;
  useEffect(() => {
    if (!opsReady) return;
    let live = true;
    act("lookup.index").then((r) => {
      if (live && r?.index) setIndex(r.index as LookupIndex);
    });
    return () => {
      live = false;
    };
  }, [act, opsReady]);
  const places = data.places ?? NO_PLACES;
  // The location staff are working at: counts, − and +, and new items apply there.
  const [atPick, setAtPick] = useState("");
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        setAtPick(window.localStorage.getItem(AT_KEY) ?? "");
      } catch {
        /* storage blocked: start at totals */
      }
    }, 0);
    return () => clearTimeout(t);
  }, []);
  const at = places.locations.some((l) => l.id === atPick) ? atPick : "";
  const pickAt = (id: string) => {
    setAtPick(id);
    try {
      window.localStorage.setItem(AT_KEY, id);
    } catch {
      /* storage blocked: the pick lasts until reload */
    }
  };
  const [onlyHere, setOnlyHere] = useState(false);
  const [adding, setAdding] = useState(false);
  const [moving, setMoving] = useState(false);
  const [importing, setImporting] = useState(false);
  const here = places.locations.find((l) => l.id === at);
  const qtyOf = (p: Product) => (at ? (places.onhand[p.id]?.[at] ?? 0) : p.qty);

  const counts: Record<Filter, number> = { all: data.products.length, live: 0, out: 0, noprice: 0 };
  let atCost = 0;
  let atRetail = 0;
  let costed = 0;
  for (const p of data.products) {
    counts[adminStatus(p).key]++;
    const c = data.costs[p.id]?.cost_cents ?? 0;
    if (c > 0) {
      atCost += c * qtyOf(p);
      costed++;
    }
    atRetail += (p.price_cents ?? 0) * qtyOf(p);
  }

  const needle = q.trim().toLowerCase();
  // A typed search also looks at UPCs, replaced numbers and near-miss spelling, best match first.
  const smart = needle ? smartSearch(needle, data.products, index, (id) => (at ? places.onhand[id]?.[at] : undefined), 60).map((f) => f.id) : [];
  const rank = new Map(smart.map((id, i) => [id, i]));
  const inBin = bin && !needle ? new Set(bin.product_ids) : null;
  const shown = data.products
    .filter((p) => {
      // A scanned bin shows every part kept in it; a scanned part shows that part. Both skip the other filters.
      if (inBin) return inBin.has(p.id);
      if (picked && !needle) return p.id === picked;
      if (filter !== "all" && adminStatus(p).key !== filter) return false;
      if (at && onlyHere && !(qtyOf(p) > 0)) return false;
      return !needle || rank.has(p.id) || [p.name, p.part_number, p.thread, p.size, p.dash].join(" ").toLowerCase().includes(needle);
    })
    .sort((a, b) => (needle ? (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999) : 0));

  async function applyBulk() {
    const m = Number(bulk.replace(/[%\s]/g, ""));
    if (bulk.trim() === "" || !Number.isFinite(m) || m < 0 || m >= 100) return say("Enter a margin from 0 to 99.", true);
    const done = await act("price.bulk", { margin: m });
    if (done) say(`Repriced ${done.repriced} item${done.repriced === 1 ? "" : "s"} at ${m}% margin`);
  }

  const chips: Array<[Filter, string]> = [
    ["all", "All"],
    ["live", "Live in shop"],
    ["out", "Temp out of stock"],
    ["noprice", "Needs a price"],
  ];
  const editingProduct = editing && editing !== "new" ? data.products.find((p) => p.id === editing) : undefined;

  return (
    <>
      <div className="inv-head">
        <div>
          <p className="eyebrow">Back office</p>
          <h1>Inventory</h1>
        </div>
        <button type="button" className="btn" onClick={() => setEditing("new")}>
          Add item
        </button>
      </div>
      {places.ready && (
        <div className="at-bar">
          <label htmlFor="inv-at">
            Working at
            <select id="inv-at" value={at} onChange={(e) => pickAt(e.target.value)}>
              <option value="">All locations (totals)</option>
              {places.dealers.map((d) => {
                const locs = places.locations.filter((l) => l.dealer_id === d.id);
                return locs.length ? (
                  <optgroup key={d.id} label={d.name}>
                    {locs.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null;
              })}
            </select>
          </label>
          <div className="inline">
            <button type="button" className="btn ghost sm" onClick={() => setAdding(true)}>
              Add location
            </button>
            {places.locations.length > 1 && (
              <button type="button" className="btn ghost sm" onClick={() => setMoving(true)}>
                Move stock
              </button>
            )}
            {data.ops?.ready && (
              <button type="button" className="btn ghost sm" onClick={() => setImporting(true)}>
                Import spreadsheet
              </button>
            )}
          </div>
          <p className="hint">
            {here
              ? `Counts, − and +, and new items below are for ${here.name}.`
              : places.locations.length > 1
                ? "Totals across all locations. Pick a location to enter or change its counts."
                : "Counts are for your one location. Add a location to keep stock in more than one place."}
          </p>
          {here && (
            <label className="at-only">
              <input type="checkbox" checked={onlyHere} onChange={(e) => setOnlyHere(e.target.checked)} /> Only items stocked at {here.name}
            </label>
          )}
        </div>
      )}
      <p className="sub">
        {here ? `At ${here.name}` : "On the shelf"}: {money(atCost)} at cost ({costed} of {data.products.length} items costed), {money(atRetail)} at
        sell price.
      </p>

      <div className="toolbar">
        <PartFinder
          parts={data.products}
          index={index}
          shelf={(id) => (at ? places.onhand[id]?.[at] : undefined)}
          results={false}
          label="Find an item"
          inputId="invQ"
          onQuery={(v) => {
            setQ(v);
            if (v) {
              setBin(null);
              setPicked("");
            }
          }}
          onBin={(b) => {
            setBin(b);
            setPicked("");
          }}
          onPick={(id) => {
            // A scan or an exact match goes straight to that part's stock, ready to type how many came in.
            setPicked(id);
            setBin(null);
            setScanned(true);
            setStockOf(id);
          }}
          photo={
            opsReady
              ? async (image, type) => {
                  const r = await act("lookup.photo", { image, type });
                  return r ? { read: r.read as PhotoRead } : { problem: "The photo couldn't be read. Type the number instead." };
                }
              : undefined
          }
          onLink={
            opsReady
              ? async (code, id) => {
                  const r = await act("upc.link", { product_id: id, code });
                  if (r?.index) setIndex(r.index as LookupIndex);
                  return !!r;
                }
              : undefined
          }
        />
        {(bin || picked) && !needle && (
          <div className="inline">
            <span>{bin ? `Showing bin ${bin.code}: ${bin.product_ids.length} part${bin.product_ids.length === 1 ? "" : "s"} kept there.` : "Showing the part you scanned."}</span>
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => {
                setBin(null);
                setPicked("");
              }}
            >
              Show all items
            </button>
          </div>
        )}
        <div className="chips" role="group" aria-label="Status">
          {chips.map(([id, label]) => (
            <button key={id} type="button" className="chip" aria-pressed={filter === id} onClick={() => setFilter(id)}>
              {label}
              <span className="n">{counts[id]}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="bulk">
        <label htmlFor="bulkMargin">Set one margin for every item</label>
        <div className="inline">
          <input
            id="bulkMargin"
            inputMode="decimal"
            placeholder="40"
            autoComplete="off"
            value={bulk}
            onChange={(e) => setBulk(e.target.value)}
          />
          <span>%</span>
          <button type="button" className="btn ghost sm" onClick={applyBulk}>
            Reprice items that have a cost
          </button>
        </div>
        <p className="hint">
          Margin is profit as a share of the sell price. Sell price = cost ÷ (1 − margin). Type a margin and the
          price fills in; type a price and the margin fills in.
        </p>
      </div>

      <div className="rowhead" aria-hidden="true">
        <span>Item</span>
        <span>On hand</span>
        <span>Cost $</span>
        <span>Margin %</span>
        <span>Sell price $</span>
        <span>Status</span>
      </div>
      <ul className="rows">
        {shown.map((p) => (
          <Row
            key={p.id}
            p={p}
            cost={data.costs[p.id]}
            held={data.held?.[p.id] ?? 0}
            places={places}
            at={at}
            act={act}
            say={say}
            onEdit={() => setEditing(p.id)}
            onStock={() => {
              setScanned(false);
              setStockOf(p.id);
            }}
          />
        ))}
      </ul>
      {shown.length === 0 && (
        <p className="empty">
          {data.products.length ? "No items match." : "No items yet. Use Add item to create the first one."}
        </p>
      )}

      {adding && (
        <AddLocation
          places={places}
          act={act}
          say={say}
          onClose={() => setAdding(false)}
          onSaved={(id) => {
            setAdding(false);
            pickAt(id);
          }}
        />
      )}
      {importing && (
        <ImportStock
          products={data.products}
          places={places}
          at={at}
          act={act}
          say={say}
          codes={index.codes}
          onClose={() => {
            setImporting(false);
            // New barcodes may have been linked: read the index again so a scan finds them.
            if (opsReady) void act("lookup.index").then((r) => r?.index && setIndex(r.index as LookupIndex));
          }}
        />
      )}
      {moving && <MoveStock products={data.products} places={places} from={at} act={act} say={say} onClose={() => setMoving(false)} />}
      {stockOf && data.products.some((p) => p.id === stockOf) && (
        <StockHistory
          key={stockOf}
          product={data.products.find((p) => p.id === stockOf)!}
          held={data.held?.[stockOf] ?? 0}
          places={data.places ?? NO_PLACES}
          act={act}
          say={say}
          receiveAt={scanned ? at : ""}
          quick={scanned}
          onClose={() => {
            setStockOf(null);
            if (scanned) {
              // Back to the box, ready for the next scan.
              setScanned(false);
              setTimeout(() => document.getElementById("invQ")?.focus(), 60);
            }
          }}
        />
      )}
      {editing && (
        <ItemEditor
          key={editing}
          locationId={at || null}
          locationName={places.locations.length > 1 ? (here?.name ?? null) : null}
          product={editingProduct}
          act={act}
          say={say}
          reload={reload}
          onClose={() => setEditing(null)}
          onCreated={(id) => setEditing(id)}
        />
      )}
    </>
  );
}

function Row({
  p,
  cost,
  held,
  places,
  at,
  act,
  say,
  onEdit,
  onStock,
}: {
  p: Product;
  cost: Cost | undefined;
  held: number;
  places: Places;
  /** The location being worked at, or "" for totals. */
  at: string;
  act: Act;
  say: Say;
  onEdit: () => void;
  onStock: () => void;
}) {
  const many = places.locations.length > 1;
  const here = places.locations.find((l) => l.id === at);
  // With several locations and none picked, the number is a total and can't be typed over.
  const locked = many && !here;
  const shownQty = here ? (places.onhand[p.id]?.[here.id] ?? 0) : p.qty;
  const where = here ? { location_id: here.id } : {};
  const c = cost?.cost_cents ?? null;
  const price = p.price_cents;
  const shownMargin = c && c > 0 && price && price > 0 ? marginFrom(c, price) : (cost?.margin ?? null);
  const status = adminStatus(p);

  function saveQty(e: React.FocusEvent<HTMLInputElement>) {
    const n = Number(e.target.value.trim());
    if (e.target.value.trim() === "" || !Number.isInteger(n) || n < 0) {
      e.target.value = String(shownQty);
      return say("Quantity must be a whole number, 0 or more.", true);
    }
    if (n !== shownQty) act("qty.count", { id: p.id, qty: n, ...where });
  }

  async function saveCost(e: React.FocusEvent<HTMLInputElement>) {
    const cents = toCents(e.target.value);
    if (Number.isNaN(cents) || (cents != null && cents < 0)) {
      e.target.value = dollars(c);
      return say("Cost must be a number.", true);
    }
    if (cents === c) return;
    const done = await act("cost.set", { id: p.id, cost_cents: cents });
    if (done && typeof done.repriced === "number") {
      say(`Price set to ${money(done.repriced)} to hold ${done.margin}% margin`);
    }
  }

  function saveMargin(e: React.FocusEvent<HTMLInputElement>) {
    const text = e.target.value.replace(/[%\s]/g, "");
    if (text === "") {
      if (cost?.margin != null) act("margin.set", { id: p.id, margin: null });
      return;
    }
    const m = Number(text);
    if (!Number.isFinite(m) || m >= 100) {
      e.target.value = shownMargin == null ? "" : String(shownMargin);
      return say("Margin must be a number below 100.", true);
    }
    if (!(c && c > 0)) {
      e.target.value = "";
      return say("Enter the cost first, then the margin.", true);
    }
    if (m !== shownMargin) act("margin.set", { id: p.id, margin: m });
  }

  function savePrice(e: React.FocusEvent<HTMLInputElement>) {
    const cents = toCents(e.target.value);
    if (Number.isNaN(cents) || (cents != null && cents < 0)) {
      e.target.value = dollars(price);
      return say("Price must be a number.", true);
    }
    const value = cents === 0 ? null : cents;
    if (value !== price) act("price.set", { id: p.id, price_cents: value });
  }

  return (
    <li className="row">
      <div className="r-head">
        <span className="thumb">
          <Picture product={p} />
        </span>
        <div className="r-info">
          <strong>{p.name}</strong>
          <span>{p.part_number ? `Part # ${p.part_number}` : "No part #"}</span>
          <span>{specLine(p)}</span>
        </div>
        <div className="inline">
          <button type="button" className="btn ghost sm" onClick={onStock}>
            Stock
          </button>
          <button type="button" className="btn ghost sm" onClick={onEdit}>
            Edit
          </button>
        </div>
      </div>
      <div className="r-qty">
        <span className="lbl">{here ? `At ${here.code || here.name}` : many ? "Total" : "On hand"}</span>
        <div className="stepper">
          <button
            type="button"
            aria-label={`Subtract one ${p.name}${here ? ` at ${here.name}` : ""}`}
            disabled={locked || shownQty <= 0}
            onClick={() => act("qty.adjust", { id: p.id, delta: -1, ...where })}
          >
            −
          </button>
          <input
            key={`qty-${at}-${shownQty}`}
            id={`qty-${p.id}`}
            inputMode="numeric"
            autoComplete="off"
            aria-label={
              locked
                ? `Total on hand at all locations, ${p.name}. Pick a location above to change it.`
                : `Quantity on hand${here ? ` at ${here.name}` : ""}, ${p.name}`
            }
            defaultValue={shownQty}
            readOnly={locked}
            onBlur={locked ? undefined : saveQty}
            onKeyDown={blurOnEnter}
          />
          <button
            type="button"
            aria-label={`Add one ${p.name}${here ? ` at ${here.name}` : ""}`}
            disabled={locked}
            onClick={() => act("qty.adjust", { id: p.id, delta: 1, ...where })}
          >
            +
          </button>
        </div>
        {many && (
          <span className="where-note">
            {here ? `${p.qty} in all · ` : ""}
            {countsLine(places.onhand[p.id], places.locations) || "None at any location"}
          </span>
        )}
        {held > 0 && (
          <span className="held-note">
            {held} in checkout · {Math.max(0, p.qty - held)} free to sell
          </span>
        )}
      </div>
      <label htmlFor={`cost-${p.id}`}>
        <span className="lbl">Cost $</span>
        <input
          key={`cost-${c}`}
          id={`cost-${p.id}`}
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          defaultValue={dollars(c)}
          onBlur={saveCost}
          onKeyDown={blurOnEnter}
        />
      </label>
      <label htmlFor={`margin-${p.id}`}>
        <span className="lbl">Margin %</span>
        <input
          key={`margin-${shownMargin}`}
          id={`margin-${p.id}`}
          inputMode="decimal"
          autoComplete="off"
          placeholder="%"
          defaultValue={shownMargin ?? ""}
          onBlur={saveMargin}
          onKeyDown={blurOnEnter}
        />
      </label>
      <label htmlFor={`price-${p.id}`}>
        <span className="lbl">Sell price $</span>
        <input
          key={`price-${price}`}
          id={`price-${p.id}`}
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          defaultValue={dollars(price)}
          onBlur={savePrice}
          onKeyDown={blurOnEnter}
        />
      </label>
      <div className="r-status">
        <span className={`pill ${status.tone}`}>{status.text}</span>
      </div>
    </li>
  );
}

/** Shrinks a phone photo to a web-friendly JPEG before upload. */
async function shrink(file: File): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    canvas.getContext("2d")?.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.86));
    if (blob) return blob;
  } catch {
    /* fall back to the original file */
  }
  return file;
}

function ItemEditor({
  product,
  locationId,
  locationName,
  act,
  say,
  reload,
  onClose,
  onCreated,
}: {
  product: Product | undefined;
  /** Where a new item's starting count goes; null for the default location. */
  locationId: string | null;
  /** Shown beside the count when there are several locations. */
  locationName: string | null;
  act: Act;
  say: Say;
  reload: () => Promise<void>;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [f, setF] = useState({
    name: product?.name ?? "",
    type: product?.type ?? "jic-cap",
    part_number: product?.part_number ?? "",
    size: product?.size ?? "",
    dash: product?.dash ?? "",
    thread: product?.thread ?? "",
    description: product?.description ?? "",
    qty: "",
  });
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [details, setDetails] = useState(false);
  const set = (key: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setF((cur) => ({ ...cur, [key]: e.target.value }));

  async function save() {
    if (!f.name.trim()) return say("Give the item a name.", true);
    const fields: Record<string, unknown> = {
      name: f.name,
      type: f.type,
      part_number: f.part_number,
      size: f.size,
      dash: f.dash,
      thread: f.thread,
      description: f.description,
    };
    setBusy(true);
    if (product) {
      const done = await act("product.update", { id: product.id, fields });
      setBusy(false);
      if (done) {
        say("Saved");
        onClose();
      }
      return;
    }
    const qty = f.qty.trim() === "" ? 0 : Number(f.qty);
    if (!Number.isInteger(qty) || qty < 0) {
      setBusy(false);
      return say("Quantity must be a whole number, 0 or more.", true);
    }
    const done = await act("product.create", { fields: { ...fields, qty }, ...(locationId ? { location_id: locationId } : {}) });
    setBusy(false);
    if (done && typeof done.id === "string") {
      say("Item added. Add photos now, then set its cost and price in the list.");
      onCreated(done.id);
    }
  }

  async function addPhotos(files: FileList | null) {
    if (!product || !files?.length) return;
    setUploading(true);
    for (const file of Array.from(files)) {
      const blob = await shrink(file);
      const type = ["image/jpeg", "image/png", "image/webp"].includes(blob.type) ? blob.type : "";
      if (!type) {
        say("That photo format isn't supported. Use JPG, PNG or WebP.", true);
        continue;
      }
      try {
        const res = await fetch(`/api/admin/photo?id=${encodeURIComponent(product.id)}`, {
          method: "POST",
          headers: { "Content-Type": type },
          body: blob,
        });
        if (!res.ok) {
          const reply = (await res.json().catch(() => ({}))) as { message?: string };
          say(reply.message ?? "The photo didn't upload. Try again.", true);
        }
      } catch {
        say("The photo didn't upload. Check your connection.", true);
      }
    }
    await reload();
    setUploading(false);
  }

  async function remove() {
    if (!product) return;
    if (!confirmDelete) return setConfirmDelete(true);
    setBusy(true);
    const done = await act("product.delete", { id: product.id });
    setBusy(false);
    if (done) {
      say("Item deleted");
      onClose();
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={product ? "Edit item" : "Add item"}
      footer={
        <>
          {product && (
            <button type="button" className="btn danger" style={{ marginRight: "auto" }} disabled={busy} onClick={remove}>
              {confirmDelete ? "Tap again to delete for good" : "Delete item"}
            </button>
          )}
          <button type="button" className="btn ghost" onClick={onClose}>
            {product ? "Close" : "Cancel"}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={save}>
            {product ? "Save" : "Add item"}
          </button>
        </>
      }
    >
      <div className="form">
        <label htmlFor="f-name">
          Item name
          <input id="f-name" maxLength={80} autoComplete="off" placeholder="37° JIC Cap 1/4 FJ" value={f.name} onChange={set("name")} />
        </label>
        <div className="two">
          <label htmlFor="f-type">
            Type
            <select id="f-type" value={f.type} onChange={set("type")}>
              {TYPES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor="f-pn">
            Part #
            <input id="f-pn" maxLength={40} autoComplete="off" value={f.part_number} onChange={set("part_number")} />
          </label>
        </div>
        <div className="two">
          <label htmlFor="f-size">
            Size
            <input id="f-size" maxLength={12} autoComplete="off" placeholder="1/4" value={f.size} onChange={set("size")} />
          </label>
          <label htmlFor="f-dash">
            Dash size
            <input id="f-dash" maxLength={8} autoComplete="off" placeholder="-04" value={f.dash} onChange={set("dash")} />
          </label>
          <label htmlFor="f-thread">
            Thread
            <input id="f-thread" maxLength={30} autoComplete="off" placeholder="7/16-20" value={f.thread} onChange={set("thread")} />
          </label>
        </div>
        {!product && (
          <label htmlFor="f-qty">
            {locationName ? `Quantity on hand at ${locationName}` : "Quantity on hand"}
            <input id="f-qty" inputMode="numeric" autoComplete="off" placeholder="0" value={f.qty} onChange={set("qty")} />
          </label>
        )}
        <label htmlFor="f-desc">
          Description
          <textarea id="f-desc" maxLength={600} value={f.description} onChange={set("description")} />
        </label>

        {product && (
          <div className="det-open">
            <div>
              <h3>Catalog details</h3>
              <p className="hint">Category, specs, cross-reference numbers, shipping size, core charge, kit parts, stock elsewhere, documents.</p>
            </div>
            <button type="button" className="btn ghost sm" onClick={() => setDetails(true)}>
              Open
            </button>
          </div>
        )}

        <div>
          <h3>Photos</h3>
          <p className="hint">
            {product
              ? "The first photo is the one shown in the shop. Photos save as soon as they upload."
              : "Add the item first, then photos."}
          </p>
        </div>
        {product && (
          <>
            <div className="photos">
              {product.photos.map((path, i) => (
                <div className="ph" key={path}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- small admin thumbnail */}
                  <img src={photoUrl(path)} alt={`Photo ${i + 1}`} />
                  {i === 0 && <span className="first">SHOP</span>}
                  <button
                    type="button"
                    className="rm"
                    aria-label={`Remove photo ${i + 1}`}
                    onClick={() => act("photo.delete", { id: product.id, path })}
                  >
                    ×
                  </button>
                  {i > 0 && (
                    <button type="button" className="linkbtn" onClick={() => act("photo.first", { id: product.id, path })}>
                      Make first
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div>
              <span className="btn ghost sm filebtn">
                {uploading ? "Uploading…" : "Add photos"}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  multiple
                  aria-label="Add photos"
                  disabled={uploading}
                  onChange={(e) => {
                    const files = e.target.files;
                    addPhotos(files).finally(() => {
                      e.target.value = "";
                    });
                  }}
                />
              </span>
            </div>
          </>
        )}
      </div>
      {details && product && <DetailsEditor product={product} say={say} onClose={() => setDetails(false)} />}
    </Modal>
  );
}

const MOVE_LABEL: Record<StockMove["kind"], string> = {
  start: "Starting count",
  receive: "Received",
  count: "Recount",
  adjust: "Adjusted",
  edit: "Changed",
  sale: "Sold",
  return: "Returned",
  transfer: "Moved",
};

/**
 * An item's stock: its count at each location, what moved it and when, and
 * forms to log a shipment, recount a location, or move parts between them.
 */
function StockHistory({
  product,
  held,
  places,
  act,
  say,
  onClose,
  receiveAt = "",
  quick = false,
}: {
  product: Product;
  held: number;
  places: Places;
  act: Act;
  say: Say;
  onClose: () => void;
  /** The location being worked, when the panel was opened by a scan. */
  receiveAt?: string;
  /** Opened by a scan: start in "How many" and close after the count is saved, ready for the next scan. */
  quick?: boolean;
}) {
  const [moves, setMoves] = useState<StockMove[] | null>(null);
  const [numbers, setNumbers] = useState<Record<string, number>>({});
  const locations = places.locations;
  const many = locations.length > 1;
  const home = places.default_location_id ?? locations[0]?.id ?? "";
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");
  const [rcvAt, setRcvAt] = useState(receiveAt && locations.some((l) => l.id === receiveAt) ? receiveAt : home);
  const qtyBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!quick) return;
    const t = setTimeout(() => qtyBox.current?.focus(), 80);
    return () => clearTimeout(t);
  }, [quick]);
  const [mv, setMv] = useState({ qty: "", from: "", to: "" });
  const [busy, setBusy] = useState(false);
  const counts = places.onhand[product.id] ?? {};
  const placeName = (id: string | null) => (id ? (locations.find((l) => l.id === id)?.name ?? "") : "");

  const [version, setVersion] = useState(0);
  const load = () => setVersion((v) => v + 1);
  useEffect(() => {
    let live = true;
    act("stock.history", { id: product.id }).then((r) => {
      if (!live) return;
      setMoves(((r?.moves as StockMove[]) ?? []));
      setNumbers((r?.numbers as Record<string, number>) ?? {});
    });
    return () => {
      live = false;
    };
  }, [act, product.id, version]);

  async function receive(e: React.FormEvent) {
    e.preventDefault();
    const n = Number(qty.trim());
    if (!Number.isInteger(n) || n < 1) return say("Enter how many came in, 1 or more.", true);
    setBusy(true);
    const done = await act("qty.adjust", { id: product.id, delta: n, kind: "receive", note, ...(rcvAt ? { location_id: rcvAt } : {}) });
    setBusy(false);
    if (done) {
      say(`Added ${n} to ${product.name}${many ? ` at ${placeName(rcvAt)}` : ""}`);
      setQty("");
      setNote("");
      if (quick) return onClose();
      load();
    }
  }

  async function recount(locationId: string, e: React.FocusEvent<HTMLInputElement>) {
    const n = Number(e.target.value.trim());
    const was = counts[locationId] ?? 0;
    if (e.target.value.trim() === "" || !Number.isInteger(n) || n < 0) {
      e.target.value = String(was);
      return say("Quantity must be a whole number, 0 or more.", true);
    }
    if (n === was) return;
    const done = await act("qty.count", { id: product.id, qty: n, location_id: locationId });
    if (done) {
      say(`${placeName(locationId)} recounted: ${n}`);
      load();
    }
  }

  async function transfer(e: React.FormEvent) {
    e.preventDefault();
    const n = Number(mv.qty.trim());
    if (!Number.isInteger(n) || n < 1) return say("Enter how many to move, 1 or more.", true);
    if (!mv.from || !mv.to) return say("Pick where the parts are and where they go.", true);
    if (mv.from === mv.to) return say("Pick two different locations.", true);
    setBusy(true);
    const done = await act("qty.transfer", { id: product.id, qty: n, from: mv.from, to: mv.to });
    setBusy(false);
    if (done) {
      say(`Moved ${n} from ${placeName(mv.from)} to ${placeName(mv.to)}`);
      setMv({ qty: "", from: "", to: "" });
      load();
    }
  }

  const when = (iso: string) =>
    new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  return (
    <Modal open onClose={onClose} title={`Stock: ${product.name}`}>
      <p className="stock-now">
        <b>{product.qty}</b> on the shelf{many ? " in all" : ""}
        {held > 0 && (
          <>
            {" "}
            · <b>{held}</b> in shoppers&apos; checkouts · <b>{Math.max(0, product.qty - held)}</b> free to sell
          </>
        )}
      </p>
      {many && (
        <div className="stock-places">
          <h3>By location</h3>
          <ul>
            {locations.map((l) => (
              <li key={`${l.id}-${counts[l.id] ?? 0}`}>
                <label htmlFor={`cnt-${l.id}`}>
                  {l.name}
                  {l.id === home && <span className="hint"> (default)</span>}
                </label>
                <input
                  id={`cnt-${l.id}`}
                  inputMode="numeric"
                  autoComplete="off"
                  aria-label={`Count at ${l.name}`}
                  defaultValue={counts[l.id] ?? 0}
                  onBlur={(e) => recount(l.id, e)}
                  onKeyDown={blurOnEnter}
                />
              </li>
            ))}
          </ul>
          <p className="hint">Type a new number to log a recount at that location.</p>
        </div>
      )}
      <form className="form stock-receive" onSubmit={receive}>
        <h3>A shipment came in</h3>
        <div className="two">
          <label htmlFor="rcv-qty">
            How many
            <input id="rcv-qty" ref={qtyBox} inputMode="numeric" autoComplete="off" value={qty} onChange={(e) => setQty(e.target.value)} />
          </label>
          {many ? (
            <label htmlFor="rcv-at">
              Where
              <select id="rcv-at" value={rcvAt} onChange={(e) => setRcvAt(e.target.value)}>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
        <label htmlFor="rcv-note">
          Note (optional)
          <input
            id="rcv-note"
            maxLength={200}
            autoComplete="off"
            placeholder="Supplier, PO or packing slip"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <button type="submit" className="btn" disabled={busy}>
          {busy ? "Saving…" : "Add to stock"}
        </button>
      </form>
      {many && (
        <form className="form stock-receive" onSubmit={transfer}>
          <h3>Move parts between locations</h3>
          <div className="three">
            <label htmlFor="mv-qty">
              How many
              <input id="mv-qty" inputMode="numeric" autoComplete="off" value={mv.qty} onChange={(e) => setMv({ ...mv, qty: e.target.value })} />
            </label>
            <label htmlFor="mv-from">
              From
              <select id="mv-from" value={mv.from} onChange={(e) => setMv({ ...mv, from: e.target.value })}>
                <option value="">Pick one</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name} ({counts[l.id] ?? 0})
                  </option>
                ))}
              </select>
            </label>
            <label htmlFor="mv-to">
              To
              <select id="mv-to" value={mv.to} onChange={(e) => setMv({ ...mv, to: e.target.value })}>
                <option value="">Pick one</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button type="submit" className="btn" disabled={busy}>
            {busy ? "Saving…" : "Move parts"}
          </button>
        </form>
      )}
      <h3>History</h3>
      {moves === null ? (
        <p className="hint">Loading…</p>
      ) : moves.length === 0 ? (
        <p className="hint">No changes logged yet.</p>
      ) : (
        <ol className="stock-moves">
          {moves.map((m) => (
            <li key={m.id}>
              <span className="when">{when(m.created_at)}</span>
              <span className="what">
                {MOVE_LABEL[m.kind] ?? m.kind}
                {many && m.location_id ? ` · ${placeName(m.location_id) || "a location no longer listed"}` : ""}
                {m.order_id && numbers[m.order_id] ? ` · order #${numbers[m.order_id]}` : ""}
                {m.note ? ` · ${m.note}` : ""}
              </span>
              <span className={m.delta < 0 ? "delta out" : "delta in"}>{m.delta > 0 ? `+${m.delta}` : m.delta}</span>
              <span className="after">
                {m.qty_after} {many && m.location_id ? "there" : "left"}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Modal>
  );
}

const AT_KEY = "inv-location";

/** Add a store location for any dealer, from the inventory screen. */
function AddLocation({
  places,
  act,
  say,
  onClose,
  onSaved,
}: {
  places: Places;
  act: Act;
  say: Say;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const [dealer, setDealer] = useState(places.dealers[0]?.id ?? "");
  return (
    <Modal open onClose={onClose} title="Add a location">
      <div className="form">
        <label htmlFor="al-dealer">
          Whose location
          <select id="al-dealer" value={dealer} onChange={(e) => setDealer(e.target.value)}>
            {places.dealers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {dealer ? (
        <LocationForm key={dealer} dealerId={dealer} isDefault={false} act={act} say={say} onDone={onClose} onSaved={onSaved} />
      ) : (
        <p className="hint">Add a dealer in Settings first.</p>
      )}
      <p className="hint">Dealers, their branded stores and location details are in Settings.</p>
    </Modal>
  );
}

type MoveLine = { key: number; id: string; qty: string };

/** Move parts from one location to another: a few items, or everything at a location. */
function MoveStock({
  products,
  places,
  from: startFrom,
  act,
  say,
  onClose,
}: {
  products: Product[];
  places: Places;
  from: string;
  act: Act;
  say: Say;
  onClose: () => void;
}) {
  const [from, setFrom] = useState(startFrom);
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<MoveLine[]>([{ key: 1, id: "", qty: "" }]);
  const [next, setNext] = useState(2);
  const [busy, setBusy] = useState(false);
  const there = (id: string) => (from ? (places.onhand[id]?.[from] ?? 0) : 0);
  const stocked = products.filter((p) => there(p.id) > 0).sort((a, b) => a.name.localeCompare(b.name));
  const name = (id: string) => places.locations.find((l) => l.id === id)?.name ?? "";
  const setLine = (key: number, patch: Partial<MoveLine>) => setLines(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  function everything() {
    if (!from) return say("Pick where the parts are first.", true);
    if (!stocked.length) return say(`Nothing is stocked at ${name(from)}.`, true);
    let k = next;
    setLines(stocked.map((p) => ({ key: k++, id: p.id, qty: String(there(p.id)) })));
    setNext(k);
  }

  async function move(e: React.FormEvent) {
    e.preventDefault();
    if (!from || !to) return say("Pick where the parts are and where they go.", true);
    if (from === to) return say("Pick two different locations.", true);
    const out: Array<{ id: string; qty: number }> = [];
    for (const l of lines) {
      if (!l.id && !l.qty.trim()) continue;
      const n = Number(l.qty.trim());
      const p = products.find((x) => x.id === l.id);
      if (!p) return say("Pick an item on every line, or remove the empty line.", true);
      if (!Number.isInteger(n) || n < 1) return say(`Enter how many ${p.name} to move, 1 or more.`, true);
      if (n > there(p.id)) return say(`${name(from)} has only ${there(p.id)} ${p.name}.`, true);
      out.push({ id: p.id, qty: n });
    }
    if (!out.length) return say("Add at least one item to move.", true);
    setBusy(true);
    const done = await act("qty.transfer_many", { from, to, lines: out, note });
    setBusy(false);
    if (done) {
      const units = out.reduce((n, l) => n + l.qty, 0);
      say(`Moved ${units} part${units === 1 ? "" : "s"} (${out.length} item${out.length === 1 ? "" : "s"}) from ${name(from)} to ${name(to)}`);
      onClose();
    }
  }

  const locOptions = places.dealers.map((d) => {
    const locs = places.locations.filter((l) => l.dealer_id === d.id);
    return locs.length ? (
      <optgroup key={d.id} label={d.name}>
        {locs.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </optgroup>
    ) : null;
  });

  return (
    <Modal open onClose={onClose} title="Move stock">
      <form className="form" onSubmit={move}>
        <div className="two">
          <label htmlFor="ms-from">
            From
            <select
              id="ms-from"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setLines([{ key: next, id: "", qty: "" }]);
                setNext(next + 1);
              }}
            >
              <option value="">Pick one</option>
              {locOptions}
            </select>
          </label>
          <label htmlFor="ms-to">
            To
            <select id="ms-to" value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">Pick one</option>
              {locOptions}
            </select>
          </label>
        </div>
        {from && (
          <>
            <ul className="ms-lines">
              {lines.map((l, i) => (
                <li key={l.key}>
                  <label htmlFor={`ms-item-${l.key}`}>
                    <span className={i ? "sr" : undefined}>Item</span>
                    <select id={`ms-item-${l.key}`} value={l.id} onChange={(e) => setLine(l.key, { id: e.target.value })}>
                      <option value="">Pick an item</option>
                      {stocked.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                          {p.part_number ? ` · ${p.part_number}` : ""} ({there(p.id)} there)
                        </option>
                      ))}
                    </select>
                  </label>
                  <label htmlFor={`ms-qty-${l.key}`}>
                    <span className={i ? "sr" : undefined}>How many</span>
                    <input id={`ms-qty-${l.key}`} inputMode="numeric" autoComplete="off" value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} />
                  </label>
                  <button
                    type="button"
                    className="btn ghost sm"
                    aria-label={`Remove line ${i + 1}`}
                    onClick={() => setLines(lines.length > 1 ? lines.filter((x) => x.key !== l.key) : [{ key: l.key, id: "", qty: "" }])}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
            {stocked.length === 0 && <p className="hint">Nothing is stocked at {name(from)} yet.</p>}
            <div className="inline">
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => {
                  setLines([...lines, { key: next, id: "", qty: "" }]);
                  setNext(next + 1);
                }}
              >
                Add another item
              </button>
              <button type="button" className="btn ghost sm" onClick={everything}>
                Move everything at {name(from)}
              </button>
            </div>
          </>
        )}
        <label htmlFor="ms-note">
          Note (optional)
          <input id="ms-note" maxLength={200} autoComplete="off" placeholder="Truck run, restock, new store" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <button type="submit" className="btn" disabled={busy}>
          {busy ? "Moving…" : "Move stock"}
        </button>
      </form>
    </Modal>
  );
}
