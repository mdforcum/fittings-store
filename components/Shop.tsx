"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useRef, useState } from "react";
import { useCart, writeCart } from "@/lib/cart";
import {
  TYPES,
  money,
  sellable,
  shippingFor,
  specLine,
  stockInfo,
  typeOf,
  type Product,
  type Settings,
} from "@/lib/catalog";
import { Modal, Picture, Toast, type ToastState } from "./ui";

type Props = { products: Product[]; settings: Settings; ok: boolean; openCart: boolean };

export default function Shop({ products, settings, ok, openCart }: Props) {
  const router = useRouter();
  const cart = useCart();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all");
  const [instock, setInstock] = useState(false);
  const [cartOpen, setCartOpen] = useState(openCart);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState>(null);
  const [busy, setBusy] = useState(false);
  const [checkoutError, setCheckoutError] = useState<{ text: string; contact: boolean } | null>(null);
  const gallery = useRef<HTMLDivElement>(null);

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const say = useCallback((text: string, bad = false) => setToast({ text, bad, at: Date.now() }), []);
  const clearToast = useCallback(() => setToast(null), []);

  // Cart lines, re-checked against current stock every render.
  const lines = Object.entries(cart).map(([id, want]) => {
    const p = byId.get(id);
    const live = sellable(p);
    const qty = live ? Math.min(want, p!.qty) : want;
    return { id, p, live, qty, total: live ? qty * (p!.price_cents ?? 0) : 0 };
  });
  const liveLines = lines.filter((l) => l.live);
  const subtotal = liveLines.reduce((sum, l) => sum + l.total, 0);
  const count = liveLines.reduce((sum, l) => sum + l.qty, 0);
  const shipping = shippingFor(subtotal, settings);
  const short = Math.max(0, settings.order_min_cents - subtotal);

  function setQty(id: string, qty: number) {
    const p = byId.get(id);
    const max = sellable(p) ? p!.qty : 0;
    const next = { ...cart };
    const clamped = Math.min(Math.max(0, Math.floor(qty)), max);
    if (clamped <= 0) delete next[id];
    else next[id] = clamped;
    writeCart(next);
  }

  function add(p: Product) {
    if (!sellable(p)) return say("That item is temporarily out of stock.");
    const have = cart[p.id] ?? 0;
    if (have >= p.qty) return say(`Only ${p.qty} on hand. They are all in your cart.`);
    writeCart({ ...cart, [p.id]: have + 1 });
    say(`Added ${p.name}`);
  }

  async function checkout() {
    setBusy(true);
    setCheckoutError(null);
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: liveLines.map((l) => ({ id: l.id, qty: l.qty })) }),
      });
      const data = (await res.json()) as {
        url?: string;
        error?: string;
        message?: string;
        problems?: Array<{ id: string; available: number }>;
      };
      if (res.ok && data.url) {
        window.location.assign(data.url);
        return;
      }
      if (data.error === "stock" && data.problems) {
        const next = { ...cart };
        for (const pr of data.problems) {
          if (pr.available <= 0) delete next[pr.id];
          else next[pr.id] = pr.available;
        }
        writeCart(next);
        router.refresh();
      }
      setCheckoutError({
        text: data.message ?? "Checkout could not be started.",
        contact: data.error === "not_configured",
      });
    } catch {
      setCheckoutError({ text: "Checkout could not be reached. Check your connection and try again.", contact: false });
    }
    setBusy(false);
  }

  const needle = q.trim().toLowerCase();
  const shown = products.filter((p) => {
    if (filter !== "all" && p.type !== filter) return false;
    if (instock && !sellable(p)) return false;
    if (!needle) return true;
    return [p.name, p.part_number, p.thread, p.size, p.dash, typeOf(p.type).label]
      .join(" ")
      .toLowerCase()
      .includes(needle);
  });
  const present = TYPES.filter((t) => products.some((p) => p.type === t.id));
  const detail = detailId ? byId.get(detailId) : undefined;
  const step = (d: number) => gallery.current?.scrollBy({ left: d * gallery.current.clientWidth, behavior: "smooth" });

  const contact = (
    <>
      {settings.phone && (
        <>
          Call <a href={`tel:${settings.phone.replace(/[^\d+]/g, "")}`}>{settings.phone}</a>
        </>
      )}
      {settings.phone && settings.email && " or "}
      {settings.email && (
        <>
          email <a href={`mailto:${settings.email}`}>{settings.email}</a>
        </>
      )}
    </>
  );

  return (
    <>
      <header className="top">
        <div className="wrap">
          <Link className="brand" href="/">
            {settings.store_name}
          </Link>
          <nav aria-label="Store">
            <Link href="/hose">Hose builder</Link>
            <button type="button" className="cartbtn" onClick={() => setCartOpen(true)}>
              Cart <span className="count">{count}</span>
            </button>
          </nav>
        </div>
      </header>

      <main className="wrap">
        <div className="lead">
          <p className="eyebrow">Sold by the piece</p>
          <h1>{settings.tagline}</h1>
          <p className="sub">Match the thread, check the dash size, order by part number.</p>
          <div className="finder">
            <label className="sr" htmlFor="q">
              Search the catalog
            </label>
            <input
              type="search"
              id="q"
              placeholder="Search thread, size or part #"
              autoComplete="off"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <div className="chips" role="group" aria-label="Fitting type">
              <button type="button" className="chip" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
                All
              </button>
              {present.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="chip"
                  aria-pressed={filter === t.id}
                  onClick={() => setFilter(t.id)}
                >
                  {t.plural}
                </button>
              ))}
            </div>
            <label className="check" htmlFor="instockOnly">
              <input
                type="checkbox"
                id="instockOnly"
                checked={instock}
                onChange={(e) => setInstock(e.target.checked)}
              />{" "}
              In stock only
            </label>
          </div>
        </div>

        {!ok && <p className="empty">The catalog can&apos;t be loaded right now. Please check back shortly.</p>}
        {ok && products.length === 0 && <p className="empty">The catalog is being stocked. Check back soon.</p>}
        {ok && products.length > 0 && shown.length === 0 && (
          <p className="empty">Nothing matches that search. Try a thread size like 3/4-16 or a part number.</p>
        )}

        {TYPES.map((t) => {
          const items = shown.filter((p) => p.type === t.id);
          if (items.length === 0) return null;
          return (
            <section className="group" key={t.id}>
              <h2>
                {t.plural}
                <span>
                  {items.filter((p) => sellable(p)).length} of {items.length} in stock
                </span>
              </h2>
              <div className="grid">
                {items.map((p) => {
                  const info = stockInfo(p, settings.low_stock);
                  const live = sellable(p);
                  return (
                    <article className={`cell${p.qty <= 0 ? " is-out" : ""}`} key={p.id}>
                      <button
                        type="button"
                        className={`art${p.photos.length ? " has-photo" : ""}`}
                        aria-label={`View ${p.name}`}
                        onClick={() => setDetailId(p.id)}
                      >
                        <Picture product={p} />
                        {p.size && <span className="bin">{p.size}</span>}
                      </button>
                      <div className="meta">
                        <h3>{p.name}</h3>
                        {specLine(p) && <p className="spec">{specLine(p)}</p>}
                        {p.part_number && (
                          <p className="pn">
                            Part # <b>{p.part_number}</b>
                          </p>
                        )}
                      </div>
                      <div className="buy">
                        {(p.price_cents ?? 0) > 0 ? (
                          <div className="price">{money(p.price_cents)}</div>
                        ) : (
                          <div className="price none">Price pending</div>
                        )}
                        <span className={`pill ${info.tone}`}>{info.text}</span>
                        <button type="button" className="btn" disabled={!live} onClick={() => add(p)}>
                          {live ? "Add to cart" : p.qty <= 0 ? "Out of stock" : "Not available yet"}
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          );
        })}

        <footer className="legend">
          <dl>
            <div>
              <dt>FJ</dt> <dd>female JIC</dd>
            </div>
            <div>
              <dt>MJ</dt> <dd>male JIC</dd>
            </div>
            <div>
              <dt>MP</dt> <dd>male pipe</dd>
            </div>
            <div>
              <dt>ORB</dt> <dd>male O-ring boss</dd>
            </div>
          </dl>
          <p>Dash sizes count sixteenths of an inch: -08 fits 1/2 in. tube.</p>
          <p>
            Shipping is {money(settings.shipping_flat_cents)} per order within the US
            {settings.free_ship_over_cents != null && `, free over ${money(settings.free_ship_over_cents)}`}.
            {settings.order_min_cents > 0 && ` Minimum order ${money(settings.order_min_cents)}.`}
          </p>
          {(settings.phone || settings.email) && <p>Questions on a fitting? {contact}</p>}
        </footer>
      </main>

      {/* cart */}
      <Modal open={cartOpen} onClose={() => setCartOpen(false)} title="Cart" sheet>
        {lines.length === 0 ? (
          <p className="empty">Your cart is empty.</p>
        ) : (
          <>
            <ul>
              {lines.map((l) => (
                <li className={`line${l.live ? "" : " off"}`} key={l.id}>
                  <div>
                    <h3>{l.p ? l.p.name : "Item no longer listed"}</h3>
                    {l.p && (
                      <p className="pn">
                        Part # <b>{l.p.part_number || "n/a"}</b>
                        {l.live && ` · ${money(l.p.price_cents)} each`}
                      </p>
                    )}
                  </div>
                  <div className="amt">{l.live ? money(l.total) : ""}</div>
                  {!l.live && <p className="why">Temporarily out of stock. Not included in the total.</p>}
                  <div className="ctl">
                    {l.live ? (
                      <div className="stepper">
                        <button type="button" aria-label="One fewer" onClick={() => setQty(l.id, l.qty - 1)}>
                          −
                        </button>
                        <output aria-label="Quantity">{l.qty}</output>
                        <button
                          type="button"
                          aria-label="One more"
                          disabled={l.qty >= l.p!.qty}
                          onClick={() => setQty(l.id, l.qty + 1)}
                        >
                          +
                        </button>
                      </div>
                    ) : (
                      <span />
                    )}
                    <button
                      type="button"
                      className="linkbtn"
                      onClick={() => {
                        const next = { ...cart };
                        delete next[l.id];
                        writeCart(next);
                      }}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            <div className="sum">
              <div>
                <span>Items</span>
                <span className="mono">{money(subtotal)}</span>
              </div>
              <div>
                <span>Shipping</span>
                <span className="mono">{shipping === 0 ? "Free" : money(shipping)}</span>
              </div>
              <div className="grand">
                <span>Total before tax</span>
                <b>{money(subtotal + shipping)}</b>
              </div>
            </div>
            {short > 0 && liveLines.length > 0 && (
              <p className="warn">
                Minimum order is {money(settings.order_min_cents)}. Add {money(short)} more to check out.
              </p>
            )}
            <button
              type="button"
              className="btn"
              disabled={busy || liveLines.length === 0 || short > 0}
              onClick={checkout}
            >
              {busy ? "Opening secure checkout…" : "Checkout"}
            </button>
            <p className="hint">You&apos;ll enter your address and pay on Stripe&apos;s secure page.</p>
            {checkoutError && (
              <div className="panel" role="alert">
                <p className="err">{checkoutError.text}</p>
                {checkoutError.contact && (settings.phone || settings.email) && (
                  <p className="hint">To order now: {contact}.</p>
                )}
              </div>
            )}
          </>
        )}
      </Modal>

      {/* item detail */}
      <Modal open={!!detail} onClose={() => setDetailId(null)} title={detail ? typeOf(detail.type).label : "Item"}>
        {detail && (
          <>
            <div
              className="gallery"
              ref={gallery}
              tabIndex={0}
              aria-label="Photos"
              onKeyDown={(e) => {
                if (e.key === "ArrowRight") step(1);
                if (e.key === "ArrowLeft") step(-1);
              }}
            >
              {detail.photos.length > 0 ? (
                detail.photos.map((path) => (
                  <div key={path}>
                    <Picture product={detail} path={path} alt={detail.name} />
                  </div>
                ))
              ) : (
                <div>
                  <Picture product={detail} />
                </div>
              )}
            </div>
            {detail.photos.length > 1 && (
              <div className="gal-nav">
                <button type="button" className="btn ghost sm" onClick={() => step(-1)}>
                  Previous
                </button>
                <span className="hint">{detail.photos.length} photos</span>
                <button type="button" className="btn ghost sm" onClick={() => step(1)}>
                  Next
                </button>
              </div>
            )}
            <h3 style={{ font: "600 1.15rem/1.3 var(--body)" }}>{detail.name}</h3>
            <dl className="specs">
              {detail.part_number && (
                <>
                  <dt>Part #</dt>
                  <dd>{detail.part_number}</dd>
                </>
              )}
              {detail.size && (
                <>
                  <dt>Size</dt>
                  <dd>{detail.size}</dd>
                </>
              )}
              {detail.dash && (
                <>
                  <dt>Dash size</dt>
                  <dd>{detail.dash}</dd>
                </>
              )}
              {detail.thread && (
                <>
                  <dt>Thread</dt>
                  <dd>{detail.thread}</dd>
                </>
              )}
            </dl>
            {detail.description && <p>{detail.description}</p>}
            <div className="total">
              <span className={`pill ${stockInfo(detail, settings.low_stock).tone}`}>
                {stockInfo(detail, settings.low_stock).text}
              </span>
              {(detail.price_cents ?? 0) > 0 ? (
                <b>{money(detail.price_cents)}</b>
              ) : (
                <span className="hint">Price pending</span>
              )}
            </div>
            <button type="button" className="btn" disabled={!sellable(detail)} onClick={() => add(detail)}>
              {sellable(detail) ? "Add to cart" : detail.qty <= 0 ? "Out of stock" : "Not available yet"}
            </button>
          </>
        )}
      </Modal>

      <Toast toast={toast} clear={clearToast} />
    </>
  );
}
