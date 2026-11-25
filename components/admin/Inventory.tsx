"use client";
import { useState } from "react";
import type { AdminData, Cost } from "@/lib/admin-types";
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

type Props = { data: AdminData; act: Act; say: Say; reload: () => Promise<void> };
type Filter = "all" | "live" | "out" | "noprice";

const blurOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
  if (e.key === "Enter") e.currentTarget.blur();
};

export default function Inventory({ data, act, say, reload }: Props) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [editing, setEditing] = useState<string | null>(null); // product id, "new", or null
  const [bulk, setBulk] = useState("");

  const counts: Record<Filter, number> = { all: data.products.length, live: 0, out: 0, noprice: 0 };
  let atCost = 0;
  let atRetail = 0;
  let costed = 0;
  for (const p of data.products) {
    counts[adminStatus(p).key]++;
    const c = data.costs[p.id]?.cost_cents ?? 0;
    if (c > 0) {
      atCost += c * p.qty;
      costed++;
    }
    atRetail += (p.price_cents ?? 0) * p.qty;
  }

  const needle = q.trim().toLowerCase();
  const shown = data.products.filter((p) => {
    if (filter !== "all" && adminStatus(p).key !== filter) return false;
    return !needle || [p.name, p.part_number, p.thread, p.size, p.dash].join(" ").toLowerCase().includes(needle);
  });

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
      <p className="sub">
        On the shelf: {money(atCost)} at cost ({costed} of {data.products.length} items costed), {money(atRetail)} at
        sell price.
      </p>

      <div className="toolbar">
        <label className="sr" htmlFor="invQ">
          Find an item
        </label>
        <input
          type="search"
          id="invQ"
          placeholder="Find by name, thread or part #"
          autoComplete="off"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
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
          <Row key={p.id} p={p} cost={data.costs[p.id]} act={act} say={say} onEdit={() => setEditing(p.id)} />
        ))}
      </ul>
      {shown.length === 0 && (
        <p className="empty">
          {data.products.length ? "No items match." : "No items yet. Use Add item to create the first one."}
        </p>
      )}

      {editing && (
        <ItemEditor
          key={editing}
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
  act,
  say,
  onEdit,
}: {
  p: Product;
  cost: Cost | undefined;
  act: Act;
  say: Say;
  onEdit: () => void;
}) {
  const c = cost?.cost_cents ?? null;
  const price = p.price_cents;
  const shownMargin = c && c > 0 && price && price > 0 ? marginFrom(c, price) : (cost?.margin ?? null);
  const status = adminStatus(p);

  function saveQty(e: React.FocusEvent<HTMLInputElement>) {
    const n = Number(e.target.value.trim());
    if (e.target.value.trim() === "" || !Number.isInteger(n) || n < 0) {
      e.target.value = String(p.qty);
      return say("Quantity must be a whole number, 0 or more.", true);
    }
    if (n !== p.qty) act("product.update", { id: p.id, fields: { qty: n } });
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
        <button type="button" className="btn ghost sm" onClick={onEdit}>
          Edit
        </button>
      </div>
      <div className="r-qty">
        <span className="lbl">On hand</span>
        <div className="stepper">
          <button
            type="button"
            aria-label={`Subtract one ${p.name}`}
            disabled={p.qty <= 0}
            onClick={() => act("qty.adjust", { id: p.id, delta: -1 })}
          >
            −
          </button>
          <input
            key={`qty-${p.qty}`}
            id={`qty-${p.id}`}
            inputMode="numeric"
            autoComplete="off"
            aria-label={`Quantity on hand, ${p.name}`}
            defaultValue={p.qty}
            onBlur={saveQty}
            onKeyDown={blurOnEnter}
          />
          <button type="button" aria-label={`Add one ${p.name}`} onClick={() => act("qty.adjust", { id: p.id, delta: 1 })}>
            +
          </button>
        </div>
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
  act,
  say,
  reload,
  onClose,
  onCreated,
}: {
  product: Product | undefined;
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
    const done = await act("product.create", { fields: { ...fields, qty } });
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
            Quantity on hand
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
