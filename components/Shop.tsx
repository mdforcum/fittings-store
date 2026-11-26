"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  EMPTY_GARAGE,
  addToGarage,
  conditionLabel,
  fitState,
  readGarage,
  removeFromGarage,
  searchProducts,
  shopNav,
  underCategory,
  warrantyText,
  type FitState,
  type Garage,
  type MyMachine,
  type NavNode,
  type ShopCharge,
  type ShopFit,
  type ShopXref,
} from "@/lib/browse";
import { cartTotals, freeShipNudge, shipDay } from "@/lib/checkout-rules";
import { packageValue } from "@/lib/seal-kits";
import type { FindIt } from "@/lib/shelf";
import { madeInUSA, type Category } from "@/lib/foundation";
import MachinePicker from "./MachinePicker";
import QuoteForm from "./QuoteForm";
import { useCart, writeCart } from "@/lib/cart";
import { HELD_KEY, cartSignature, countdown, heldFromReply, heldStillGood, readHeld, type HeldCheckout } from "@/lib/holds";
import {
  TYPES,
  money,
  sellable,
  specLine,
  stockInfo,
  typeOf,
  type Product,
  type Settings,
} from "@/lib/catalog";
import { Modal, Picture, Toast, type ToastState } from "./ui";

type Props = {
  products: Product[];
  settings: Settings;
  ok: boolean;
  openCart: boolean;
  categories?: Category[];
  xrefs?: Record<string, ShopXref[]>;
  fits?: Record<string, ShopFit[]>;
  charges?: Record<string, ShopCharge[]>;
  kits?: Record<string, Array<{ product_id: string; qty: number }>>;
  /** Where each placed item sits on our shelf. */
  spots?: Record<string, FindIt>;
};

const GARAGE_KEY = "my-machines";

/** The shelves to offer as chips: the deepest branches that hold items. */
function shelves(nav: NavNode[]): NavNode[] {
  return nav.flatMap((n) => (n.children.length ? shelves(n.children) : [n]));
}

function FitPill({ state, label }: { state: FitState; label: string }) {
  if (state.kind === "unknown") return null;
  if (state.kind === "universal") return <span className="pill muted">Fits by spec</span>;
  if (state.kind === "fits") return <span className="pill ok">Fits your {label}</span>;
  if (state.kind === "checkSerial") return <span className="pill hold">Check your serial</span>;
  return <span className="pill bad">Not listed for your {label}</span>;
}

export default function Shop({ products: listed, settings, ok, openCart, categories = [], xrefs = {}, fits = {}, charges = {}, kits = {}, spots = {} }: Props) {
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
  const [shelf, setShelf] = useState("all");
  const [condition, setCondition] = useState("all");
  const [usaOnly, setUsaOnly] = useState(false);
  const [fitsOnly, setFitsOnly] = useState(false);
  const [garage, setGarage] = useState<Garage>(EMPTY_GARAGE);
  const [pickerOpen, setPickerOpen] = useState(false);
  // When in-stock parts leave the shelf. Worked out in the browser after the
  // first paint (the server's clock would be stale by the time it is read),
  // then kept current every minute.
  const [promise, setPromise] = useState("");
  useEffect(() => {
    const tick = () => setPromise(shipDay(new Date(), settings.ship_cutoff, settings.ship_tz).text);
    const first = setTimeout(tick, 0);
    const every = setInterval(tick, 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, [settings.ship_cutoff, settings.ship_tz]);

  // The customer's machines live in this browser; read them after the first paint.
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        setGarage(readGarage(window.localStorage.getItem(GARAGE_KEY)));
      } catch {
        /* storage blocked: the shop works without it */
      }
    }, 0);
    return () => clearTimeout(t);
  }, []);
  const keepGarage = useCallback((g: Garage) => {
    setGarage(g);
    try {
      window.localStorage.setItem(GARAGE_KEY, JSON.stringify(g));
    } catch {
      /* not kept past this visit */
    }
  }, []);
  const mine: MyMachine | null = garage.machines.find((m) => m.id === garage.active) ?? null;

  // A checkout this shopper started and walked away from: the parts are still
  // held for them until the payment page closes. Read after the first paint.
  const [held, setHeld] = useState<HeldCheckout | null>(null);
  const [clock, setClock] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        setHeld(readHeld(window.localStorage.getItem(HELD_KEY)));
      } catch {
        /* storage blocked: no saved checkout */
      }
      setClock(Date.now());
    }, 0);
    return () => clearTimeout(t);
  }, []);
  const cartSig = cartSignature(Object.entries(cart).map(([id, qty]) => ({ id, qty })));
  // Still running: the parts are theirs until it ends or they start over (the
  // next checkout lets it go first). The banner shows only while the cart is
  // exactly what was held.
  const running = clock > 0 && heldStillGood(held, held?.sig ?? "", clock) ? held : null;
  const ownHold = running && running.sig === cartSig ? running : null;
  useEffect(() => {
    if (!running) return;
    const every = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(every);
  }, [running]);
  const holdLeft = ownHold ? countdown(Date.parse(ownHold.ends_at), clock + ownHold.skew) : null;

  // The shop's counts leave out everything held, this shopper's own hold
  // included; give their own parts back to them.
  const products = useMemo(
    () => (running ? listed.map((p) => (running.items[p.id] ? { ...p, qty: p.qty + running.items[p.id] } : p)) : listed),
    [listed, running],
  );
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
  const count = liveLines.reduce((sum, l) => sum + l.qty, 0);
  const totals = cartTotals(
    liveLines.map((l) => ({ id: l.id, qty: l.qty, price_cents: l.p!.price_cents ?? 0, ship_class: l.p!.ship_class, price_mode: l.p!.price_mode })),
    charges,
    settings,
  );
  const { subtotal, shipping, short, plan } = totals;
  const hasCore = totals.charges.some((c) => c.kind === "core");

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
        body: JSON.stringify({ items: liveLines.map((l) => ({ id: l.id, qty: l.qty })), release: held?.order_id }),
      });
      const data = (await res.json()) as {
        url?: string;
        order_id?: string;
        held_until?: string;
        now?: string;
        error?: string;
        message?: string;
        problems?: Array<{ id: string; available: number }>;
      };
      if (res.ok && data.url) {
        try {
          if (data.order_id && data.held_until && data.now) {
            // The cart becomes exactly what is held, so the saved checkout matches it.
            writeCart(Object.fromEntries(liveLines.map((l) => [l.id, l.qty])));
            window.localStorage.setItem(HELD_KEY, JSON.stringify(heldFromReply({ order_id: data.order_id, url: data.url, held_until: data.held_until, now: data.now }, liveLines.map((l) => ({ id: l.id, qty: l.qty })))));
          } else window.localStorage.removeItem(HELD_KEY);
        } catch {
          /* storage blocked: the hold still runs on the server */
        }
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

  const xrefMap = useMemo(() => new Map(Object.entries(xrefs)), [xrefs]);
  const nav = useMemo(() => shopNav(categories, products), [categories, products]);
  const shelfList = useMemo(() => shelves(nav), [nav]);
  const shelfIds = useMemo(() => (shelf === "all" ? null : underCategory(shelf, categories)), [shelf, categories]);
  const fitOf = (p: Product) => fitState(p, fits[p.id] ?? [], mine?.id ?? null, mine?.serial ?? "");
  const anyFitment = Object.keys(fits).length > 0 || products.some((p) => p.universal);
  const conditions = [...new Set(products.map((p) => p.condition))];
  const searching = q.trim().length > 0;
  const hits = searchProducts(products, xrefMap, q).filter(({ product: p }) => {
    if (nav.length ? shelfIds && !shelfIds.has(p.category_id ?? "") : filter !== "all" && p.type !== filter) return false;
    if (condition !== "all" && p.condition !== condition) return false;
    if (instock && !sellable(p)) return false;
    if (usaOnly && !madeInUSA(p.origin)) return false;
    if (fitsOnly && mine && !["fits", "universal", "checkSerial"].includes(fitOf(p).kind)) return false;
    return true;
  });
  const because = new Map(hits.map((h) => [h.product.id, h.because]));
  const shown = hits.map((h) => h.product);
  const present = TYPES.filter((t) => products.some((p) => p.type === t.id));
  const catName = new Map(categories.map((c) => [c.id, c.name]));
  // Without a search, items stand on their shelves; with one, in order of how well they match.
  const groups: Array<{ key: string; title: string; items: Product[] }> = searching
    ? [{ key: "results", title: "Results", items: shown }]
    : nav.length
      ? [...shelfList.map((n) => n.id), "__none"].map((id) => ({
          key: id,
          title: id === "__none" ? "More parts" : (catName.get(id) ?? id),
          items: shown.filter((p) => (id === "__none" ? !shelfList.some((n) => n.id === p.category_id) : p.category_id === id)),
        }))
      : TYPES.map((t) => ({ key: t.id, title: t.plural, items: shown.filter((p) => p.type === t.id) }));
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
            <button type="button" className="mybtn" onClick={() => setPickerOpen(true)}>
              {mine ? (
                <>
                  <span className="sr">Your machine: </span>
                  {mine.label}
                </>
              ) : (
                "Pick your machine"
              )}
            </button>
            <Link href="/hose">Hose builder</Link>
            <button type="button" className="cartbtn" onClick={() => setCartOpen(true)}>
              Cart <span className="count">{count}</span>
            </button>
          </nav>
        </div>
      </header>

      {(settings.free_ship_over_cents != null || promise) && (
        <p className="promise">
          <span className="wrap">
            {settings.free_ship_over_cents != null && <span>Free shipping on parts orders over {money(settings.free_ship_over_cents)}</span>}
            {promise && <span>{promise}</span>}
          </span>
        </p>
      )}

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
              placeholder="Part #, the OEM number it replaces, thread or size"
              autoComplete="off"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            {nav.length > 0 ? (
              <div className="chips" role="group" aria-label="Shelf">
                <button type="button" className="chip" aria-pressed={shelf === "all"} onClick={() => setShelf("all")}>
                  All
                </button>
                {shelfList.map((n) => (
                  <button key={n.id} type="button" className="chip" aria-pressed={shelf === n.id} onClick={() => setShelf(n.id)}>
                    {n.name}
                  </button>
                ))}
              </div>
            ) : (
              <div className="chips" role="group" aria-label="Fitting type">
                <button type="button" className="chip" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
                  All
                </button>
                {present.map((t) => (
                  <button key={t.id} type="button" className="chip" aria-pressed={filter === t.id} onClick={() => setFilter(t.id)}>
                    {t.plural}
                  </button>
                ))}
              </div>
            )}
            {conditions.length > 1 && (
              <div className="chips" role="group" aria-label="Condition">
                <button type="button" className="chip" aria-pressed={condition === "all"} onClick={() => setCondition("all")}>
                  Any condition
                </button>
                {conditions.map((c) => (
                  <button key={c} type="button" className="chip" aria-pressed={condition === c} onClick={() => setCondition(c)}>
                    {conditionLabel(c)}
                  </button>
                ))}
              </div>
            )}
            <label className="check" htmlFor="instockOnly">
              <input
                type="checkbox"
                id="instockOnly"
                checked={instock}
                onChange={(e) => setInstock(e.target.checked)}
              />{" "}
              In stock only
            </label>
            {products.some((p) => madeInUSA(p.origin)) && (
              <label className="check" htmlFor="usaOnly">
                <input type="checkbox" id="usaOnly" checked={usaOnly} onChange={(e) => setUsaOnly(e.target.checked)} /> Made in USA only
              </label>
            )}
            {mine && anyFitment && (
              <label className="check" htmlFor="fitsOnly">
                <input type="checkbox" id="fitsOnly" checked={fitsOnly} onChange={(e) => setFitsOnly(e.target.checked)} /> Only parts
                listed for my {mine.label}
              </label>
            )}
          </div>
        </div>

        {!ok && <p className="empty">The catalog can&apos;t be loaded right now. Please check back shortly.</p>}
        {ok && products.length === 0 && <p className="empty">The catalog is being stocked. Check back soon.</p>}
        {ok && products.length > 0 && shown.length === 0 && (
          <p className="empty">
            Nothing matches that. Try a part number, the OEM number on the old part, or a thread size like 3/4-16.
          </p>
        )}

        {groups.map((g) => {
          const items = g.items;
          if (items.length === 0) return null;
          return (
            <section className="group" key={g.key}>
              <h2>
                {g.title}
                <span>
                  {items.filter((p) => sellable(p)).length} of {items.length} in stock
                </span>
              </h2>
              <div className="grid">
                {items.map((p) => {
                  const info = stockInfo(p, settings.low_stock);
                  const live = sellable(p);
                  const fit = mine ? fitOf(p) : ({ kind: "unknown" } as FitState);
                  const why = because.get(p.id);
                  const quote = p.price_mode === "quote";
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
                        {spots[p.id] && (
                          <p className="pn" title={spots[p.id].line}>
                            Shelf <b>{spots[p.id].code}</b>
                          </p>
                        )}
                        {why && <p className="because">{why}</p>}
                        {(p.condition !== "new" || mine || madeInUSA(p.origin)) && (
                          <p className="tags">
                            {madeInUSA(p.origin) && <span className="pill usa">Made in USA</span>}
                            {p.condition !== "new" && <span className="pill muted">{conditionLabel(p.condition)}</span>}
                            {mine && <FitPill state={fit} label={mine.label} />}
                          </p>
                        )}
                      </div>
                      <div className="buy">
                        {quote ? (
                          <div className="price none">Price on request</div>
                        ) : (p.price_cents ?? 0) > 0 ? (
                          <div className="price">{money(p.price_cents)}</div>
                        ) : (
                          <div className="price none">Price pending</div>
                        )}
                        {!quote && <span className={`pill ${info.tone}`}>{info.text}</span>}
                        {quote ? (
                          <button type="button" className="btn ghost" onClick={() => setDetailId(p.id)}>
                            Get a price
                          </button>
                        ) : (
                          <button type="button" className="btn" disabled={!live} onClick={() => add(p)}>
                            {live ? "Add to cart" : p.qty <= 0 ? "Out of stock" : "Not available yet"}
                          </button>
                        )}
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
                <span>Parts</span>
                <span className="mono">{money(subtotal)}</span>
              </div>
              {totals.charges.map((c) => (
                <div key={`${c.product_id}-${c.kind}`} className="charge">
                  <span>
                    {c.label}
                    {c.qty > 1 ? ` × ${c.qty}` : ""}: {byId.get(c.product_id)?.name ?? "item"}
                    {c.refundable && <em> refundable</em>}
                  </span>
                  <span className="mono">{money(c.total_cents)}</span>
                </div>
              ))}
              {plan.online && (
                <div>
                  <span>{plan.method === "pickup" ? "Pickup at the counter" : "Shipping"}</span>
                  <span className="mono">{plan.method === "pickup" || shipping === 0 ? "Free" : money(shipping)}</span>
                </div>
              )}
              <div className="grand">
                <span>{plan.online ? "Total before tax" : "Parts and charges"}</span>
                <b>{money(plan.online ? totals.total : subtotal + totals.chargesTotal)}</b>
              </div>
            </div>
            {hasCore && (
              <p className="hint">
                Core charges come back when you return the old part: full credit within 30 days, 85% from day 31 to 60.{" "}
                <Link href="/cores">How cores work</Link>
              </p>
            )}
            {plan.online && plan.method === "parcel" && liveLines.length > 0 && short <= 0 && freeShipNudge(subtotal, settings) && (
              <p className="hint">{freeShipNudge(subtotal, settings)}</p>
            )}
            {plan.online && plan.method === "parcel" && promise && <p className="hint">{promise}</p>}
            {plan.method === "pickup" && plan.online && (
              <p className="hint">Something in your cart is pickup only, so the whole order is held at the counter. We&apos;ll call when it&apos;s ready.</p>
            )}
            {short > 0 && liveLines.length > 0 && (
              <p className="warn">
                Minimum order is {money(settings.order_min_cents)}. Add {money(short)} more to check out.
              </p>
            )}
            {plan.online && ownHold && holdLeft ? (
              <div className="held">
                <p>
                  <b>Your parts are held for you.</b> Time left to pay: <span className="held-clock">{holdLeft}</span>
                </p>
                <a className="btn" href={ownHold.url}>
                  Finish checkout
                </a>
                <p className="hint">Change your cart to start over. After the time runs out, the parts go back on sale.</p>
              </div>
            ) : plan.online ? (
              <>
                <button
                  type="button"
                  className="btn"
                  disabled={busy || liveLines.length === 0 || short > 0}
                  onClick={checkout}
                >
                  {busy ? "Opening secure checkout…" : "Checkout"}
                </button>
                <p className="hint">
                  You&apos;ll {plan.method === "pickup" ? "" : "enter your address and "}pay on Stripe&apos;s secure page.
                </p>
              </>
            ) : plan.method === "freight" ? (
              <QuoteForm
                source="freight"
                intro={plan.reason}
                machine={mine?.label ?? ""}
                lines={liveLines.map((l) => ({ number: l.p!.part_number || l.p!.name, qty: l.qty, product_id: l.id }))}
              />
            ) : (
              <p className="warn">{plan.reason}</p>
            )}
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
              {detail.brand && (
                <>
                  <dt>Brand</dt>
                  <dd>{detail.brand}</dd>
                </>
              )}
              {detail.origin && (
                <>
                  <dt>Made in</dt>
                  <dd>{madeInUSA(detail.origin) ? "USA" : detail.origin}</dd>
                </>
              )}
              <dt>Condition</dt>
              <dd>
                {conditionLabel(detail.condition)}
                {detail.warranty_months ? ` · ${warrantyText(detail.warranty_months)}` : ""}
              </dd>
              {(xrefs[detail.id] ?? []).length > 0 && (
                <>
                  <dt>Replaces</dt>
                  <dd>
                    {(xrefs[detail.id] ?? [])
                      .filter((x) => x.kind !== "supplier")
                      .map((x) => `${x.brand ? `${x.brand} ` : ""}${x.number}`)
                      .join(", ") || "—"}
                  </dd>
                </>
              )}
            </dl>
            {mine && fitOf(detail).kind !== "unknown" && (
              <p className="fitline">
                <FitPill state={fitOf(detail)} label={mine.label} />{" "}
                {(() => {
                  const f = fitOf(detail);
                  return f.kind === "checkSerial" || (f.kind === "fits" && f.note) ? f.note : "";
                })()}
              </p>
            )}
            {detail.description && <p>{detail.description}</p>}
            {spots[detail.id] && (
              <div className="find-it">
                <p>
                  <b>Find it in our shop:</b> {spots[detail.id].line}
                </p>
                <p className="mono">Shelf code {spots[detail.id].code}</p>
              </div>
            )}
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
            {(kits[detail.id] ?? []).length > 0 &&
              (() => {
                const lines = kits[detail.id].map((k) => ({
                  ...k,
                  item: byId.get(k.product_id),
                  position: (fits[k.product_id] ?? []).find((f) => f.position)?.position ?? "",
                }));
                const value = packageValue(
                  detail.price_cents,
                  lines.map((l) => ({ product_id: l.product_id, qty: l.qty, price_cents: l.item?.price_cents ?? null })),
                );
                return (
                  <div className="panel kit-list">
                    <h3>What&apos;s in it: {value.kits} kit{value.kits === 1 ? "" : "s"}</h3>
                    <ul>
                      {lines.map((l) => (
                        <li key={l.product_id}>
                          <span>
                            {l.qty} × {l.position ? `${l.position}: ` : ""}
                            {l.item?.name ?? l.product_id}
                          </span>
                          {l.item?.part_number && <span className="mono">{l.item.part_number}</span>}
                        </li>
                      ))}
                    </ul>
                    {value.saves != null && value.separate != null && (
                      <p className="hint">
                        Bought one at a time: {money(value.separate)}. The package saves {money(value.saves)}.
                      </p>
                    )}
                  </div>
                );
              })()}
            {(charges[detail.id] ?? []).map((c) => (
              <p className="hint" key={c.kind}>
                Plus a {money(c.amount_cents)} {c.label.toLowerCase() || "charge"}
                {c.kind === "core" ? (
                  <>
                    , refunded when your old part comes back. <Link href="/cores">How cores work</Link>
                  </>
                ) : c.refundable ? (
                  ", refundable."
                ) : (
                  "."
                )}
              </p>
            ))}
            {detail.ship_class === "freight" || detail.ship_class === "oversize" ? (
              <p className="hint">Ships by truck: the cart sends it for a freight quote to your ZIP code.</p>
            ) : detail.ship_class === "pickup" ? (
              <p className="hint">Pickup at the counter only.</p>
            ) : null}
            {detail.price_mode === "quote" ? (
              <>
                <QuoteForm
                  key={detail.id}
                  source="product"
                  intro="Priced by quote. Big components are priced for the job: tell us the machine and serial and we'll come back with a price and a ship date."
                  machine={mine?.label ?? ""}
                  lines={[{ number: detail.part_number || detail.name, qty: 1, product_id: detail.id }]}
                />
                {(settings.phone || settings.email) && <p className="hint">{contact}.</p>}
              </>
            ) : (
              <button type="button" className="btn" disabled={!sellable(detail)} onClick={() => add(detail)}>
                {sellable(detail) ? "Add to cart" : detail.qty <= 0 ? "Out of stock" : "Not available yet"}
              </button>
            )}
          </>
        )}
      </Modal>

      <MachinePicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        garage={garage}
        onPick={(m) => {
          keepGarage(addToGarage(garage, m));
          setPickerOpen(false);
          say(`Showing fit for your ${m.label}`);
        }}
        onSwitch={(id) => keepGarage({ ...garage, active: id })}
        onRemove={(id) => keepGarage(removeFromGarage(garage, id))}
      />

      <Toast toast={toast} clear={clearToast} />
    </>
  );
}
