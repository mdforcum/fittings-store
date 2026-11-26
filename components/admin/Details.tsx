"use client";
// Catalog details for one item: where it sits on the category tree, its specs,
// every number it goes by, how it ships, extra charges, kit parts, stock at
// other places, and its documents. Opened from the item editor.
import { useEffect, useMemo, useState } from "react";
import { dollars, toCents, type Product } from "@/lib/catalog";
import {
  CONDITIONS,
  DOC_KINDS,
  MACHINE_KINDS,
  PRICE_MODES,
  EMPTY_DETAILS,
  FREIGHT_CLASSES,
  PRODUCT_KINDS,
  SHIP_CLASSES,
  STALE_DAYS,
  SURCHARGE_KINDS,
  XREF_KINDS,
  categoryLabel,
  flatTree,
  inherited,
  kitAvailable,
  machineLabel,
  numberNorm,
  shippingGaps,
  specFieldsFor,
  type CatalogMeta,
  type Details,
  type DocKind,
  type SpecField,
  type SpecValue,
  type XrefKind,
} from "@/lib/foundation";
import { positionsFor } from "@/lib/seal-kits";
import type { Say } from "../Admin";
import { Modal } from "../ui";

type Load =
  | { state: "loading" }
  | { state: "setup"; message: string }
  | { state: "error"; message: string }
  | { state: "ready"; meta: CatalogMeta };

/** Rows as typed: numbers stay text until save, so a half-typed "12." is not lost. */
type Draft = Omit<Details, "weight_oz" | "length_in" | "width_in" | "height_in" | "surcharges" | "stock" | "kit_items" | "warranty_months"> & {
  warranty: string;
  weight_lb: string;
  length_in: string;
  width_in: string;
  height_in: string;
  surcharges: Record<string, string>;
  stock: Record<string, { qty: string; lead_days: string; counted_at: string | null; touched: boolean }>;
  kit_items: Array<{ product_id: string; qty: string }>;
};

const num = (v: number | null) => (v == null ? "" : String(v));

function toDraft(d: Details): Draft {
  const surcharges: Record<string, string> = {};
  for (const s of d.surcharges) surcharges[s.kind] = dollars(s.amount_cents);
  const stock: Draft["stock"] = {};
  for (const s of d.stock) {
    stock[s.location_id] = { qty: String(s.qty), lead_days: num(s.lead_days), counted_at: s.counted_at, touched: false };
  }
  const { warranty_months, ...rest } = d;
  return {
    ...rest,
    warranty: num(warranty_months),
    weight_lb: d.weight_oz == null ? "" : String(Math.round((d.weight_oz / 16) * 100) / 100),
    length_in: num(d.length_in),
    width_in: num(d.width_in),
    height_in: num(d.height_in),
    surcharges,
    stock,
    kit_items: d.kit_items.map((k) => ({ product_id: k.product_id, qty: String(k.qty) })),
  };
}

function fromDraft(f: Draft): Record<string, unknown> {
  const n = (s: string) => (s.trim() === "" ? null : Number(s.replace(/,/g, "")));
  const lb = n(f.weight_lb);
  return {
    category_id: f.category_id ?? "",
    brand: f.brand,
    origin: f.origin,
    family: f.family,
    variant_label: f.variant_label,
    specs: f.specs,
    kind: f.kind,
    ship_class: f.ship_class,
    weight_oz: lb == null ? null : Math.round(lb * 16 * 100) / 100,
    length_in: n(f.length_in),
    width_in: n(f.width_in),
    height_in: n(f.height_in),
    freight_class: f.ship_class === "freight" || f.ship_class === "oversize" ? f.freight_class : "",
    xrefs: f.xrefs.filter((x) => numberNorm(x.number)),
    surcharges: Object.entries(f.surcharges)
      .map(([kind, v]) => ({ kind, amount_cents: toCents(v) }))
      .filter((s) => s.amount_cents != null && !Number.isNaN(s.amount_cents) && s.amount_cents > 0),
    documents: f.documents.filter((d) => d.url.trim()),
    kit_items: f.kind === "kit" ? f.kit_items.filter((k) => k.product_id).map((k) => ({ product_id: k.product_id, qty: Number(k.qty) })) : [],
    condition: f.condition,
    universal: f.universal,
    warranty_months: n(f.warranty),
    price_mode: f.price_mode,
    fitment: f.universal ? [] : f.fitment.filter((r) => r.machine_id),
    stock: Object.entries(f.stock)
      .filter(([, s]) => s.qty.trim() !== "")
      .map(([location_id, s]) => ({
        location_id,
        qty: Number(s.qty),
        lead_days: s.lead_days.trim() === "" ? null : Number(s.lead_days),
        counted_at: s.touched || !s.counted_at ? new Date().toISOString() : s.counted_at,
      })),
  };
}

function badMoney(v: string): boolean {
  const c = toCents(v);
  return c != null && (Number.isNaN(c) || c < 0);
}

export default function DetailsEditor({
  product,
  say,
  onClose,
}: {
  product: Product;
  say: Say;
  onClose: () => void;
}) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [f, setF] = useState<Draft>(toDraft(EMPTY_DETAILS));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    fetch(`/api/catalog?id=${encodeURIComponent(product.id)}`, { cache: "no-store" })
      .then(async (r) => {
        const body = (await r.json()) as { ok: boolean; message?: string; setup?: boolean; meta?: CatalogMeta; details?: Details };
        if (!live) return;
        if (!body.ok || !body.meta || !body.details) {
          setLoad(body.setup ? { state: "setup", message: body.message ?? "" } : { state: "error", message: body.message ?? "Could not load." });
          return;
        }
        setF(toDraft(body.details));
        setLoad({ state: "ready", meta: body.meta });
      })
      .catch(() => live && setLoad({ state: "error", message: "No connection. Close this and try again." }));
    return () => {
      live = false;
    };
  }, [product.id]);

  const meta = load.state === "ready" ? load.meta : null;
  const tree = useMemo(() => (meta ? flatTree(meta.categories) : []), [meta]);
  const fields = meta ? specFieldsFor(f.category_id, meta.categories) : [];
  const suggestedShip = meta ? inherited(f.category_id, meta.categories, "default_ship") : null;

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setF((cur) => ({ ...cur, [key]: value }));
  const setSpec = (key: string, value: SpecValue | null) =>
    setF((cur) => {
      const specs = { ...cur.specs };
      if (value == null || value === "" || (Array.isArray(value) && value.length === 0)) delete specs[key];
      else specs[key] = value;
      return { ...cur, specs };
    });

  async function save() {
    setError("");
    const badSurcharge = Object.entries(f.surcharges).find(([, v]) => badMoney(v));
    if (badSurcharge) {
      setError(`${SURCHARGE_KINDS.find((k) => k.id === badSurcharge[0])?.label}: enter an amount like 45.00`);
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/catalog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "details.save", id: product.id, details: fromDraft(f) }),
      });
      const body = (await r.json()) as { ok: boolean; message?: string; details?: Details };
      if (!body.ok || !body.details) {
        setError(body.message ?? "That did not save. Try again.");
        return;
      }
      setF(toDraft(body.details));
      say("Catalog details saved");
    } catch {
      setError("No connection. Your changes are still here; try again.");
    } finally {
      setBusy(false);
    }
  }

  const gaps = shippingGaps({
    ship_class: f.ship_class,
    weight_oz: Number(f.weight_lb) > 0 ? Number(f.weight_lb) * 16 : null,
    length_in: Number(f.length_in) || null,
    width_in: Number(f.width_in) || null,
    height_in: Number(f.height_in) || null,
    freight_class: f.freight_class,
  });

  const kitCan =
    meta && f.kind === "kit"
      ? kitAvailable(
          f.kit_items.filter((k) => k.product_id && Number(k.qty) > 0).map((k) => ({ product_id: k.product_id, qty: Number(k.qty) })),
          (id) => meta.items.find((i) => i.id === id)?.qty ?? 0,
        )
      : 0;

  return (
    <Modal
      open
      onClose={onClose}
      title="Catalog details"
      footer={
        <>
          {error && (
            <p className="err" role="alert" style={{ marginRight: "auto" }}>
              {error}
            </p>
          )}
          <button type="button" className="btn ghost" onClick={onClose}>
            Close
          </button>
          <button type="button" className="btn" disabled={busy || load.state !== "ready"} onClick={save}>
            {busy ? "Saving…" : "Save details"}
          </button>
        </>
      }
    >
      <p className="hint">
        <strong>{product.name}</strong>
        {product.part_number ? ` · Part # ${product.part_number}` : ""}. Nothing here changes what shoppers see yet; the shop starts
        using it category by category.
      </p>

      {load.state === "loading" && <p className="hint">Loading…</p>}
      {load.state === "setup" && (
        <div className="det-note" role="status">
          <strong>One setup step first.</strong> {load.message}
        </div>
      )}
      {load.state === "error" && <p className="err">{load.message}</p>}

      {meta && (
        <div className="form det">
          <section>
            <h3>Where it sits</h3>
            <label htmlFor="d-cat">
              Category
              <select id="d-cat" value={f.category_id ?? ""} onChange={(e) => set("category_id", e.target.value || null)}>
                <option value="">Not placed yet</option>
                {tree.map((c) => (
                  <option key={c.id} value={c.id}>
                    {" ".repeat(c.depth)}
                    {c.name}
                    {c.live ? "" : " (not in shop yet)"}
                  </option>
                ))}
              </select>
            </label>
            {f.category_id && <p className="hint">{categoryLabel(f.category_id, meta.categories)}</p>}
            <div className="two">
              <label htmlFor="d-kind">
                What it is
                <select id="d-kind" value={f.kind} onChange={(e) => set("kind", e.target.value as Draft["kind"])}>
                  {PRODUCT_KINDS.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.label}
                    </option>
                  ))}
                </select>
              </label>
              <label htmlFor="d-brand">
                Brand
                <input id="d-brand" maxLength={60} autoComplete="off" placeholder="Baldwin" value={f.brand} onChange={(e) => set("brand", e.target.value)} />
              </label>
              <label htmlFor="d-origin">
                Made in (as the supplier states it)
                <input id="d-origin" maxLength={40} autoComplete="off" list="d-origins" placeholder="USA" value={f.origin} onChange={(e) => set("origin", e.target.value)} />
                <datalist id="d-origins">
                  <option value="USA" />
                  <option value="Canada" />
                  <option value="Mexico" />
                  <option value="China" />
                  <option value="India" />
                </datalist>
              </label>
            </div>
            <div className="two">
              <label htmlFor="d-family">
                Sold in sizes as
                <input
                  id="d-family"
                  maxLength={80}
                  autoComplete="off"
                  placeholder="15W-40 engine oil"
                  value={f.family}
                  onChange={(e) => set("family", e.target.value)}
                />
              </label>
              <label htmlFor="d-variant">
                This size
                <input
                  id="d-variant"
                  maxLength={60}
                  autoComplete="off"
                  placeholder="5 gal pail"
                  value={f.variant_label}
                  onChange={(e) => set("variant_label", e.target.value)}
                />
              </label>
            </div>
            <p className="hint">Items with the same &ldquo;sold in sizes as&rdquo; name share one page in the shop, with a size picker.</p>
            <div className="two">
              <label htmlFor="d-cond">
                Condition
                <select id="d-cond" value={f.condition} onChange={(e) => set("condition", e.target.value as Draft["condition"])}>
                  {CONDITIONS.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
              <label htmlFor="d-warranty">
                Warranty (months)
                <input
                  id="d-warranty"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="None stated"
                  value={f.warranty}
                  onChange={(e) => set("warranty", e.target.value)}
                />
              </label>
            </div>
            <label htmlFor="d-pmode">
              How it sells
              <select id="d-pmode" value={f.price_mode} onChange={(e) => set("price_mode", e.target.value as Draft["price_mode"])}>
                {PRICE_MODES.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            {f.price_mode === "quote" && (
              <p className="hint">Big components (final drives, swing motors, engines) usually sell this way. Requests land in the back office.</p>
            )}
          </section>

          <FitSection f={f} set={set} meta={meta} />

          {fields.length > 0 && (
            <section>
              <h3>Specs</h3>
              <div className="two">
                {fields.map((fl) => (
                  <SpecInput key={fl.key} field={fl} product={product} value={f.specs[fl.key]} onChange={(v) => setSpec(fl.key, v)} />
                ))}
              </div>
            </section>
          )}

          <section>
            <h3>Numbers it goes by</h3>
            <p className="hint">
              OEM numbers, aftermarket equals, the supplier&rsquo;s number, old numbers it replaced, and its UPC. A customer
              typing any of them finds this item. The part # on the item itself always counts.
            </p>
            {f.xrefs.map((x, i) => (
              <div className="det-row" key={i}>
                <select
                  aria-label="Kind of number"
                  value={x.kind}
                  onChange={(e) => set("xrefs", f.xrefs.map((y, j) => (j === i ? { ...y, kind: e.target.value as XrefKind } : y)))}
                >
                  {XREF_KINDS.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.label}
                    </option>
                  ))}
                </select>
                <input
                  aria-label="Brand"
                  placeholder="Brand"
                  maxLength={40}
                  value={x.brand}
                  onChange={(e) => set("xrefs", f.xrefs.map((y, j) => (j === i ? { ...y, brand: e.target.value } : y)))}
                />
                <input
                  aria-label="Number"
                  placeholder="Number"
                  maxLength={40}
                  value={x.number}
                  onChange={(e) =>
                    set(
                      "xrefs",
                      f.xrefs.map((y, j) => (j === i ? { ...y, number: e.target.value, number_norm: numberNorm(e.target.value) } : y)),
                    )
                  }
                />
                <button type="button" className="x" aria-label="Remove number" onClick={() => set("xrefs", f.xrefs.filter((_, j) => j !== i))}>
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => set("xrefs", [...f.xrefs, { kind: "oem", brand: "", number: "", number_norm: "" }])}
            >
              Add a number
            </button>
          </section>

          <section>
            <h3>How it ships</h3>
            <label htmlFor="d-ship">
              Shipping
              <select id="d-ship" value={f.ship_class} onChange={(e) => set("ship_class", e.target.value as Draft["ship_class"])}>
                {SHIP_CLASSES.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}: {c.hint}
                  </option>
                ))}
              </select>
            </label>
            {suggestedShip && suggestedShip !== f.ship_class && (
              <p className="hint">
                Items in this category usually ship as {SHIP_CLASSES.find((c) => c.id === suggestedShip)?.label.toLowerCase()}.{" "}
                <button type="button" className="linkbtn" onClick={() => set("ship_class", suggestedShip)}>
                  Use that
                </button>
              </p>
            )}
            {f.ship_class !== "pickup" && (
              <div className="two">
                <label htmlFor="d-wt">
                  Weight, packed (lb)
                  <input id="d-wt" inputMode="decimal" autoComplete="off" value={f.weight_lb} onChange={(e) => set("weight_lb", e.target.value)} />
                </label>
                <label htmlFor="d-l">
                  Length (in)
                  <input id="d-l" inputMode="decimal" autoComplete="off" value={f.length_in} onChange={(e) => set("length_in", e.target.value)} />
                </label>
                <label htmlFor="d-w">
                  Width (in)
                  <input id="d-w" inputMode="decimal" autoComplete="off" value={f.width_in} onChange={(e) => set("width_in", e.target.value)} />
                </label>
                <label htmlFor="d-h">
                  Height (in)
                  <input id="d-h" inputMode="decimal" autoComplete="off" value={f.height_in} onChange={(e) => set("height_in", e.target.value)} />
                </label>
                {(f.ship_class === "freight" || f.ship_class === "oversize") && (
                  <label htmlFor="d-fc">
                    Freight class
                    <select id="d-fc" value={f.freight_class} onChange={(e) => set("freight_class", e.target.value)}>
                      <option value="">Pick one</option>
                      {FREIGHT_CLASSES.map((c) => (
                        <option key={c} value={c}>
                          Class {c}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            )}
            {gaps.length > 0 && (
              <p className="hint">Needed for a live shipping quote and an arrival date: {gaps.join(", ")}.</p>
            )}
          </section>

          <section>
            <h3>Extra charges</h3>
            <p className="hint">Each shows as its own line on the page, in the cart and on the receipt. Leave blank for none.</p>
            <div className="two">
              {SURCHARGE_KINDS.map((k) => (
                <label key={k.id} htmlFor={`d-sc-${k.id}`}>
                  {k.label} ($){k.refundable ? ", refunded on return" : ""}
                  <input
                    id={`d-sc-${k.id}`}
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="0.00"
                    value={f.surcharges[k.id] ?? ""}
                    aria-invalid={badMoney(f.surcharges[k.id] ?? "") || undefined}
                    onChange={(e) => set("surcharges", { ...f.surcharges, [k.id]: e.target.value })}
                  />
                </label>
              ))}
            </div>
          </section>

          {f.kind === "kit" && (
            <section>
              <h3>Kit parts</h3>
              <p className="hint">
                A kit sells only as many as its scarcest part allows. Right now that is <strong>{kitCan}</strong>.
              </p>
              {f.kit_items.map((k, i) => (
                <div className="det-row" key={i}>
                  <select
                    aria-label="Part"
                    value={k.product_id}
                    onChange={(e) => set("kit_items", f.kit_items.map((y, j) => (j === i ? { ...y, product_id: e.target.value } : y)))}
                  >
                    <option value="">Pick a part</option>
                    {meta.items
                      .filter((it) => it.id !== product.id)
                      .map((it) => (
                        <option key={it.id} value={it.id}>
                          {it.name}
                          {it.part_number ? ` (${it.part_number})` : ""} · {it.qty} on hand
                        </option>
                      ))}
                  </select>
                  <input
                    aria-label="How many in the kit"
                    inputMode="numeric"
                    style={{ maxWidth: 80 }}
                    value={k.qty}
                    onChange={(e) => set("kit_items", f.kit_items.map((y, j) => (j === i ? { ...y, qty: e.target.value } : y)))}
                  />
                  <button type="button" className="x" aria-label="Remove part" onClick={() => set("kit_items", f.kit_items.filter((_, j) => j !== i))}>
                    ×
                  </button>
                </div>
              ))}
              <button type="button" className="btn ghost sm" onClick={() => set("kit_items", [...f.kit_items, { product_id: "", qty: "1" }])}>
                Add a part
              </button>
            </section>
          )}

          <section>
            <h3>Stock at other places</h3>
            <p className="hint">
              Our own shelf is the on-hand count on the item. Counts here are for a dealer&rsquo;s shelf or a supplier. A count
              older than {STALE_DAYS} days is shown to customers as &ldquo;call to confirm&rdquo; instead of a delivery date.
            </p>
            {meta.locations.length === 0 && <p className="hint">No places yet. Places you survey from the phone show up here.</p>}
            {meta.locations.map((l) => {
              const s = f.stock[l.id] ?? { qty: "", lead_days: "", counted_at: null, touched: false };
              const put = (patch: Partial<typeof s>) => set("stock", { ...f.stock, [l.id]: { ...s, ...patch, touched: true } });
              return (
                <div className="det-row" key={l.id}>
                  <span className="det-place">
                    {l.name}
                    <small>
                      {l.kind === "survey" ? "surveyed place" : l.kind}
                      {s.counted_at && !s.touched ? ` · counted ${new Date(s.counted_at).toLocaleDateString()}` : ""}
                    </small>
                  </span>
                  <input aria-label={`On hand at ${l.name}`} inputMode="numeric" placeholder="Qty" value={s.qty} onChange={(e) => put({ qty: e.target.value })} />
                  <input
                    aria-label={`Business days to get it from ${l.name}`}
                    inputMode="numeric"
                    placeholder="Days"
                    value={s.lead_days}
                    onChange={(e) => put({ lead_days: e.target.value })}
                  />
                </div>
              );
            })}
          </section>

          <section>
            <h3>Documents</h3>
            <p className="hint">Spec sheets, safety data sheets, install guides and links to the maker&rsquo;s manuals.</p>
            {f.documents.map((d, i) => (
              <div className="det-row" key={i}>
                <select
                  aria-label="Kind of document"
                  value={d.kind}
                  onChange={(e) => set("documents", f.documents.map((y, j) => (j === i ? { ...y, kind: e.target.value as DocKind } : y)))}
                >
                  {DOC_KINDS.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.label}
                    </option>
                  ))}
                </select>
                <input
                  aria-label="Title"
                  placeholder="Title"
                  maxLength={120}
                  value={d.title}
                  onChange={(e) => set("documents", f.documents.map((y, j) => (j === i ? { ...y, title: e.target.value } : y)))}
                />
                <input
                  aria-label="Link"
                  placeholder="https://"
                  inputMode="url"
                  maxLength={600}
                  value={d.url}
                  onChange={(e) => set("documents", f.documents.map((y, j) => (j === i ? { ...y, url: e.target.value } : y)))}
                />
                <button type="button" className="x" aria-label="Remove document" onClick={() => set("documents", f.documents.filter((_, j) => j !== i))}>
                  ×
                </button>
              </div>
            ))}
            <button type="button" className="btn ghost sm" onClick={() => set("documents", [...f.documents, { kind: "spec", title: "", url: "" }])}>
              Add a document
            </button>
          </section>
        </div>
      )}
    </Modal>
  );
}

function SpecInput({
  field,
  product,
  value,
  onChange,
}: {
  field: SpecField;
  product: Product;
  value: SpecValue | undefined;
  onChange: (v: SpecValue | null) => void;
}) {
  const id = `d-spec-${field.key}`;
  const label = `${field.label}${field.unit ? ` (${field.unit})` : ""}`;
  if (field.column) {
    const v = (product as unknown as Record<string, unknown>)[field.column];
    return (
      <label htmlFor={id}>
        {label}
        <input id={id} readOnly value={typeof v === "string" ? v : ""} title="Edit this on the item itself" />
      </label>
    );
  }
  if (field.type === "bool") {
    return (
      <label htmlFor={id}>
        {label}
        <select id={id} value={value === true ? "yes" : value === false ? "no" : ""} onChange={(e) => onChange(e.target.value === "" ? null : e.target.value === "yes")}>
          <option value="">Not known</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      </label>
    );
  }
  if (field.type === "choice") {
    return (
      <label htmlFor={id}>
        {label}
        <select id={id} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">Not set</option>
          {(field.choices ?? []).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (field.type === "multi") {
    return (
      <label htmlFor={id}>
        {label}
        <input
          id={id}
          autoComplete="off"
          placeholder="Separate with commas"
          value={Array.isArray(value) ? value.join(", ") : typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value.split(",").map((s) => s.trimStart()) as string[])}
        />
      </label>
    );
  }
  return (
    <label htmlFor={id}>
      {label}
      <input
        id={id}
        autoComplete="off"
        inputMode={field.type === "number" ? "decimal" : undefined}
        value={value == null ? "" : String(value)}
        onChange={(e) => onChange(e.target.value)}
      />
      {field.note && <small className="hint">{field.note}</small>}
    </label>
  );
}

const STRENGTHS = [
  { id: "confirmed", label: "Fits (parts data)" },
  { id: "spec", label: "Meets its spec" },
] as const;

function FitSection({
  f,
  set,
  meta,
}: {
  f: Draft;
  set: <K extends keyof Draft>(key: K, value: Draft[K]) => void;
  meta: CatalogMeta;
}) {
  const rows = f.fitment;
  const put = (i: number, patch: Partial<Draft["fitment"][number]>) => set("fitment", rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const groups = MACHINE_KINDS.map((k) => ({ ...k, machines: meta.machines.filter((m) => m.kind === k.id) })).filter((g) => g.machines.length);
  return (
    <section>
      <h3>Fits these machines</h3>
      <label className="det-check" htmlFor="d-universal">
        <input id="d-universal" type="checkbox" checked={f.universal} onChange={(e) => set("universal", e.target.checked)} />
        Universal: fits by spec (a bearing, a light, a pin), not by model
      </label>
      {f.universal ? (
        <p className="hint">Universal parts show &ldquo;fits most machines&rdquo; with the specs that decide fit, and skip the machine check.</p>
      ) : meta.machines.length === 0 ? (
        <p className="hint">No machines yet. Add the lineup on the Machines tab, then list here which ones this part fits.</p>
      ) : (
        <>
          <p className="hint">
            Leave the serial range empty when it fits every serial. Cat machines go by a three-character prefix plus the number
            after it, for example prefix ABC, 1 to 4999.
          </p>
          {rows.map((r, i) => {
            const m = meta.machines.find((mm) => mm.id === r.machine_id);
            return (
              <div className="det-fit" key={i}>
                <div className="det-fit-top">
                  <select aria-label="Machine" value={r.machine_id} onChange={(e) => put(i, { machine_id: e.target.value, serial_prefix: "" })}>
                    <option value="">Pick a machine</option>
                    {groups.map((g) => (
                      <optgroup key={g.id} label={g.label}>
                        {g.machines.map((mm) => (
                          <option key={mm.id} value={mm.id}>
                            {machineLabel(mm)}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  <select aria-label="How sure" value={r.strength} onChange={(e) => put(i, { strength: e.target.value as "confirmed" | "spec" })}>
                    {STRENGTHS.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="x" aria-label="Remove machine" onClick={() => set("fitment", rows.filter((_, j) => j !== i))}>
                    ×
                  </button>
                </div>
                <div className="det-fit-serial">
                  {m && m.serial_prefixes.length > 0 ? (
                    <select aria-label="Serial prefix" value={r.serial_prefix} onChange={(e) => put(i, { serial_prefix: e.target.value })}>
                      <option value="">Any prefix</option>
                      {m.serial_prefixes.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input aria-label="Serial prefix" placeholder="Prefix" maxLength={6} value={r.serial_prefix} onChange={(e) => put(i, { serial_prefix: e.target.value.toUpperCase() })} />
                  )}
                  <input aria-label="Serial from" placeholder="Serial from" maxLength={40} value={r.serial_from} onChange={(e) => put(i, { serial_from: e.target.value })} />
                  <input aria-label="Serial to" placeholder="Serial to" maxLength={40} value={r.serial_to} onChange={(e) => put(i, { serial_to: e.target.value })} />
                  <input
                    aria-label="Where on the machine"
                    placeholder="Position (Boom, Dipper…)"
                    maxLength={60}
                    list={`fit-pos-${i}`}
                    value={r.position}
                    onChange={(e) => put(i, { position: e.target.value })}
                  />
                  <datalist id={`fit-pos-${i}`}>
                    {positionsFor(m?.kind).map((p) => (
                      <option key={p} value={p} />
                    ))}
                  </datalist>
                </div>
              </div>
            );
          })}
          <button
            type="button"
            className="btn ghost sm"
            onClick={() =>
              set("fitment", [
                ...rows,
                { machine_id: "", position: "", serial_prefix: "", serial_from: "", serial_to: "", engine: "", qty_used: 1, strength: "confirmed", note: "" },
              ])
            }
          >
            Add a machine
          </button>
        </>
      )}
    </section>
  );
}
