"use client";
// Dealers and their store locations: where parts are kept and sold from.
import { useState } from "react";
import type { AdminData } from "@/lib/admin-types";
import { normCode, type Dealer, type StoreLocation } from "@/lib/places";
import { bpsToPercent, percentToBps } from "@/lib/settlements";
import { dollarsToCents, type Storefront } from "@/lib/storefront";

const centsText = (c: number) => (c / 100).toFixed(2);
import type { Act, Say } from "../Admin";

type Props = { data: AdminData; act: Act; say: Say };

export default function Locations({ data, act, say }: Props) {
  const places = data.places;
  const [newDealer, setNewDealer] = useState("");
  if (!places?.ready) {
    return (
      <div className="card">
        <h2>Dealers and locations</h2>
        <p className="hint">Locations aren&apos;t set up yet. They switch on when the locations database change has run.</p>
      </div>
    );
  }

  async function addDealer(e: React.FormEvent) {
    e.preventDefault();
    if (!newDealer.trim()) return say("Give the dealer a name.", true);
    const done = await act("dealer.save", { name: newDealer });
    if (done) {
      say(`Added ${newDealer.trim()}`);
      setNewDealer("");
    }
  }

  return (
    <div className="card">
      <h2>Dealers and locations</h2>
      <p className="hint">
        Each location keeps its own count of every part. Paid orders come from one location that has everything, starting with the
        default; if none has it all, each part comes from wherever it is.
      </p>
      {data.routing?.ready && <RoutingBlock data={data} act={act} say={say} />}
      {data.routing?.ready && <MileageBlock data={data} act={act} say={say} />}
      {data.ops?.ready && <LabelsBlock data={data} act={act} say={say} />}
      {places.dealers.map((d) => (
        <DealerBlock key={d.id} dealer={d} data={data} act={act} say={say} />
      ))}
      <form className="form loc-add-dealer" onSubmit={addDealer}>
        <label htmlFor="new-dealer">
          Add a dealer
          <input id="new-dealer" maxLength={80} autoComplete="off" placeholder="Dealer name" value={newDealer} onChange={(e) => setNewDealer(e.target.value)} />
        </label>
        <button type="submit" className="btn ghost">
          Add dealer
        </button>
      </form>
    </div>
  );
}

function DealerBlock({ dealer, data, act, say }: { dealer: Dealer; data: AdminData; act: Act; say: Say }) {
  const mine = data.places.locations.filter((l) => l.dealer_id === dealer.id);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState(dealer.name);

  async function rename() {
    if (name.trim() === dealer.name) return;
    if (!name.trim()) {
      setName(dealer.name);
      return say("Give the dealer a name.", true);
    }
    const done = await act("dealer.save", { dealer_id: dealer.id, name });
    if (done) say("Dealer name saved");
  }

  return (
    <section className="loc-dealer" aria-label={dealer.name}>
      <label htmlFor={`dealer-${dealer.id}`} className="loc-dealer-name">
        Dealer
        <input
          id={`dealer-${dealer.id}`}
          maxLength={80}
          autoComplete="off"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={rename}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
      </label>
      {mine.length === 0 && <p className="hint">No locations yet.</p>}
      <ul className="loc-list">
        {mine.map((l) => (
          <li key={l.id}>
            <LocationForm
              dealerId={dealer.id}
              loc={l}
              isDefault={data.places.default_location_id === l.id}
              routable={!!data.routing?.ready && data.routing.house_dealer_id !== dealer.id}
              address={!!data.ops?.ready}
              act={act}
              say={say}
            />
          </li>
        ))}
      </ul>
      {adding ? (
        <LocationForm
          dealerId={dealer.id}
          isDefault={false}
          routable={!!data.routing?.ready && data.routing.house_dealer_id !== dealer.id}
          address={!!data.ops?.ready}
          act={act}
          say={say}
          onDone={() => setAdding(false)}
        />
      ) : (
        <button type="button" className="btn ghost sm" onClick={() => setAdding(true)}>
          Add a location for {dealer.name}
        </button>
      )}
      {data.ops?.ready && <DealerContacts dealer={dealer} data={data} act={act} say={say} />}
      {data.ops?.ready && data.routing?.house_dealer_id !== dealer.id && <DealerLogins dealer={dealer} act={act} say={say} />}
      <StorefrontBlock dealer={dealer} data={data} act={act} say={say} />
    </section>
  );
}

export function LocationForm({
  dealerId,
  loc,
  isDefault,
  routable = false,
  address = false,
  act,
  say,
  onDone,
  onSaved,
}: {
  dealerId: string;
  loc?: StoreLocation;
  isDefault: boolean;
  /** An outside dealer's location, once routing is set up: it may opt in to Backroad Iron orders. */
  routable?: boolean;
  /** Show the ship-from street and phone (once the operations database change has run). */
  address?: boolean;
  act: Act;
  say: Say;
  onDone?: () => void;
  /** Called with the saved location's id. */
  onSaved?: (id: string) => void;
}) {
  const key = loc?.id ?? "new";
  const [f, setF] = useState({
    name: loc?.name ?? "",
    code: loc?.code ?? "",
    city: loc?.city ?? "",
    state: loc?.state ?? "",
    zip: loc?.zip ?? "",
    ships: loc?.ships ?? true,
    pickup: loc?.pickup ?? true,
    active: loc?.active ?? true,
    make_default: false,
    takes_routed: loc?.takes_routed ?? false,
    street1: loc?.street1 ?? "",
    street2: loc?.street2 ?? "",
    phone: loc?.phone ?? "",
  });
  const [busy, setBusy] = useState(false);
  const set = (k: "name" | "code" | "city" | "state" | "zip" | "street1" | "street2" | "phone") => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF({ ...f, [k]: k === "code" ? normCode(e.target.value) : k === "state" ? e.target.value.toUpperCase().slice(0, 2) : e.target.value });
  const tick = (k: "ships" | "pickup" | "active" | "make_default" | "takes_routed") => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF({ ...f, [k]: e.target.checked });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { takes_routed, street1, street2, phone, ...rest } = f;
    const done = await act("location.save", {
      ...rest,
      ...(routable ? { takes_routed } : {}),
      ...(address ? { street1, street2, phone } : {}),
      dealer_id: dealerId,
      ...(loc ? { location_id: loc.id } : {}),
    });
    setBusy(false);
    if (done) {
      say(loc ? `${f.name.trim()} saved` : `Added ${f.name.trim()}`);
      if (typeof done.location_id === "string") onSaved?.(done.location_id);
      onDone?.();
    }
  }

  return (
    <form className="form loc-form" onSubmit={save} aria-label={loc ? `Location ${loc.name}` : "New location"}>
      <div className="two">
        <label htmlFor={`ln-${key}`}>
          Location name
          <input id={`ln-${key}`} maxLength={60} autoComplete="off" placeholder="Effingham store" value={f.name} onChange={set("name")} />
        </label>
        <label htmlFor={`lc-${key}`}>
          Short code
          <input id={`lc-${key}`} maxLength={6} autoComplete="off" placeholder="EFF" value={f.code} onChange={set("code")} />
        </label>
      </div>
      {address && (
        <div className="two">
          <label htmlFor={`ls1-${key}`}>
            Street address <span className="hint">(labels ship from here)</span>
            <input id={`ls1-${key}`} maxLength={80} autoComplete="off" value={f.street1} onChange={set("street1")} />
          </label>
          <label htmlFor={`ls2-${key}`}>
            Suite or building <span className="hint">(optional)</span>
            <input id={`ls2-${key}`} maxLength={80} autoComplete="off" value={f.street2} onChange={set("street2")} />
          </label>
        </div>
      )}
      <div className="three">
        <label htmlFor={`lcity-${key}`}>
          City
          <input id={`lcity-${key}`} maxLength={50} autoComplete="off" value={f.city} onChange={set("city")} />
        </label>
        <label htmlFor={`lst-${key}`}>
          State
          <input id={`lst-${key}`} maxLength={2} autoComplete="off" placeholder="IL" value={f.state} onChange={set("state")} />
        </label>
        <label htmlFor={`lzip-${key}`}>
          ZIP
          <input id={`lzip-${key}`} inputMode="numeric" maxLength={5} autoComplete="off" value={f.zip} onChange={set("zip")} />
        </label>
      </div>
      {address && (
        <label htmlFor={`lph-${key}`} className="loc-phone">
          Phone for the carrier <span className="hint">(optional)</span>
          <input id={`lph-${key}`} type="tel" maxLength={30} autoComplete="off" value={f.phone} onChange={set("phone")} />
        </label>
      )}
      <div className="loc-ticks">
        <label>
          <input type="checkbox" checked={f.ships} onChange={tick("ships")} /> Ships orders
        </label>
        <label>
          <input type="checkbox" checked={f.pickup} onChange={tick("pickup")} /> Counter pickup
        </label>
        <label>
          <input type="checkbox" checked={f.active} onChange={tick("active")} /> Open
        </label>
        {routable && (
          <label>
            <input type="checkbox" checked={f.takes_routed} onChange={tick("takes_routed")} /> Takes Backroad Iron orders
          </label>
        )}
        {isDefault ? (
          <span className="loc-default">Default location</span>
        ) : (
          <label>
            <input type="checkbox" checked={f.make_default} onChange={tick("make_default")} /> Make default
          </label>
        )}
      </div>
      <div className="inline">
        <button type="submit" className="btn sm" disabled={busy}>
          {busy ? "Saving…" : loc ? "Save location" : "Add location"}
        </button>
        {onDone && (
          <button type="button" className="btn ghost sm" onClick={onDone}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

/** Real mileage for "nearest": a one-time load of ZIP code centers. */
function MileageBlock({ data, act, say }: Props) {
  const z = data.ops?.zips ?? { ready: false, count: 0 };
  const [busy, setBusy] = useState(false);
  return (
    <div className="panel loc-form" role="group" aria-label="Real mileage">
      <h3>Real mileage</h3>
      <p className="hint">
        When an order is routed, &quot;nearest&quot; can mean the shortest distance in miles from the shopper&apos;s ZIP code to each location&apos;s ZIP code
        (straight-line, not road miles). Without this it means same first three ZIP digits, then same state.
      </p>
      {!z.ready ? (
        <p className="warn">Run supabase/add-zip-miles.sql in the Supabase SQL Editor to switch this on.</p>
      ) : (
        <>
          <p>{z.count > 0 ? `${z.count.toLocaleString("en-US")} ZIP codes loaded. Routing uses miles.` : "No ZIP codes loaded yet, so routing still uses the rough rule."}</p>
          <div className="inline">
            <button
              type="button"
              className={z.count > 0 ? "btn ghost" : "btn"}
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const r = await act("zips.load");
                setBusy(false);
                if (r) say(`${Number(r.loaded ?? 0).toLocaleString("en-US")} ZIP codes loaded. Routing now uses miles.`);
              }}
            >
              {busy ? "Loading…" : z.count > 0 ? "Load ZIP codes again" : "Load ZIP codes"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Whether dealers can buy shipping labels on the dealer page, and any markup on them. */
function LabelsBlock({ data, act, say }: Props) {
  const l = data.ops.labels;
  const [f, setF] = useState({ on: l.on, markup: bpsToPercent(l.markup_bps), flat: (l.flat_cents / 100).toFixed(2) });
  const [busy, setBusy] = useState(false);
  const canUse = l.ready && l.shippo;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const bps = percentToBps(f.markup);
    const flatText = f.flat.replace(/[$\s]/g, "");
    const flat = /^\d+(\.\d{1,2})?$/.test(flatText) ? Math.round(Number(flatText) * 100) : Number.NaN;
    if (Number.isNaN(bps)) return say("The markup is a percent from 0 to 50. Use 0 for none.", true);
    if (Number.isNaN(flat) || flat > 2000) return say("The flat amount per label is dollars from 0 to 20. Use 0 for none.", true);
    setBusy(true);
    const done = await act("labels.save", { on: f.on, markup_bps: bps, flat_cents: flat });
    setBusy(false);
    if (done) say(f.on ? "Dealers can buy labels on their dealer page now" : "Dealer labels saved (turned off)");
  }

  return (
    <form className="form panel loc-form" onSubmit={save} aria-label="Dealer shipping labels">
      <h3>Dealer shipping labels</h3>
      <p className="hint">
        Lets a dealer buy a label for its part of an order from the dealer page, on your Shippo account. The label cost, plus any markup
        below, comes off that dealer&apos;s statement. Dealers can always type in a tracking number from their own carrier account instead.
      </p>
      {!l.ready && <p className="warn">Run supabase/add-dealer-labels.sql in the Supabase SQL Editor to switch this on.</p>}
      {l.ready && !l.shippo && <p className="warn">Shippo isn&apos;t connected yet. Add SHIPPO_API_TOKEN in Vercel.</p>}
      <div className="loc-ticks">
        <label>
          <input type="checkbox" checked={f.on} disabled={!canUse} onChange={(e) => setF({ ...f, on: e.target.checked })} /> Dealers can buy labels on the
          dealer page
        </label>
      </div>
      <div className="two">
        <label htmlFor="lbl-markup">
          Markup on the label cost, % <span className="hint">(0 for none)</span>
          <input id="lbl-markup" inputMode="decimal" value={f.markup} onChange={(e) => setF({ ...f, markup: e.target.value })} />
        </label>
        <label htmlFor="lbl-flat">
          Flat amount per label, $ <span className="hint">(0 for none)</span>
          <input id="lbl-flat" inputMode="decimal" value={f.flat} onChange={(e) => setF({ ...f, flat: e.target.value })} />
        </label>
      </div>
      <p className="hint">
        With both at 0, dealers pay exactly what the label costs you. Before you turn this on, ask Shippo whether your account type covers
        labels that your dealers ship.
      </p>
      <div className="inline">
        <button type="submit" className="btn sm" disabled={busy || !l.ready}>
          {busy ? "Saving…" : "Save label settings"}
        </button>
      </div>
    </form>
  );
}

/** Where a dealer's order alerts go: email and a cell phone for texts. */
function DealerContacts({ dealer, data, act, say }: { dealer: Dealer; data: AdminData; act: Act; say: Say }) {
  const [email, setEmail] = useState(dealer.alert_email ?? "");
  const [phone, setPhone] = useState(dealer.alert_phone ?? "");
  const [busy, setBusy] = useState(false);
  const changed = email !== (dealer.alert_email ?? "") || phone !== (dealer.alert_phone ?? "");
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const done = await act("dealer.save", { dealer_id: dealer.id, name: dealer.name, alert_email: email, alert_phone: phone });
    setBusy(false);
    if (done) say("Alert contacts saved");
  }
  return (
    <form className="form loc-form" onSubmit={save} aria-label={`${dealer.name} alerts`}>
      <h3>Order alerts</h3>
      <div className="two">
        <label htmlFor={`ae-${dealer.id}`}>
          Email <span className="hint">(up to 3, commas between)</span>
          <input id={`ae-${dealer.id}`} maxLength={300} autoComplete="off" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label htmlFor={`ap-${dealer.id}`}>
          Cell phone for texts
          <input id={`ap-${dealer.id}`} type="tel" maxLength={30} autoComplete="off" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </label>
      </div>
      <p className="hint">
        {data.ops.email || data.ops.text
          ? `Sends by ${[data.ops.email && "email", data.ops.text && "text"].filter(Boolean).join(" and ")} when an order needs parts from ${dealer.name}'s shelves, and a running-low list each week.`
          : "Messages are saved but not sent until an email service (Resend) or text service (Twilio) is set up in Vercel. Dealers still see every order on their dealer page."}
      </p>
      <div className="inline">
        <button type="submit" className="btn sm" disabled={busy || !changed}>
          {busy ? "Saving…" : "Save alert contacts"}
        </button>
      </div>
    </form>
  );
}

type DealerLogin = { id: string; email: string; name: string; disabled: boolean; last_login_at: string | null; role: "manager" | "worker" };

/** People at a dealer who can sign in to the dealer page to see and ship their orders. */
function DealerLogins({ dealer, act, say }: { dealer: Dealer; act: Act; say: Say }) {
  const [users, setUsers] = useState<DealerLogin[] | null>(null);
  const [f, setF] = useState({ email: "", name: "", password: "", role: "worker" });
  const [busy, setBusy] = useState(false);
  // Roles show once supabase/add-dealer-roles.sql has run.
  const [roles, setRoles] = useState(false);
  async function load() {
    const r = await act("dealer_user.list", { dealer_id: dealer.id });
    if (!r) return;
    const list = (r.users as DealerLogin[]) ?? [];
    setUsers(list);
    setRoles(r.roles === true);
    // The first login at a dealer should be a manager: someone has to approve counts and set the shop rules.
    if (!list.some((u) => u.role === "manager" && !u.disabled)) setF((x) => ({ ...x, role: "manager" }));
  }
  async function setRole(u: DealerLogin, role: string) {
    const r = await act("dealer_user.role", { user_id: u.id, role });
    if (r) say(`${u.name || u.email} is now a ${role}`);
    await load();
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const r = await act("dealer_user.save", { dealer_id: dealer.id, ...f });
    setBusy(false);
    if (r) {
      say(r.reset ? `New password set for ${f.email}` : `${f.email} can sign in now. Send them the dealer page link and the password.`);
      setF({ email: "", name: "", password: "", role: "worker" });
      await load();
    }
  }
  async function toggle(u: DealerLogin) {
    const r = await act("dealer_user.disable", { user_id: u.id, disabled: !u.disabled });
    if (r) {
      say(u.disabled ? `${u.email} can sign in again` : `${u.email} can't sign in now`);
      await load();
    }
  }
  return (
    <div className="loc-form loc-logins">
      <h3>Dealer page logins</h3>
      <p className="hint">
        People at {dealer.name} sign in at <span className="mono">/dealer</span> to see orders to pull, print pick lists and mark them shipped. Give
        each person their own login, so the record shows who did what.
      </p>
      {roles && (
        <p className="hint">
          A <b>manager</b> can also see the statement, approve big count changes, set the shop&apos;s rules (such as a second check before an order ships)
          and override that check with a reason. A <b>worker</b> pulls, packs, ships and counts.
        </p>
      )}
      {users == null ? (
        <button type="button" className="btn ghost sm" onClick={load}>
          Show logins
        </button>
      ) : (
        <>
          {users.length === 0 && <p className="hint">No logins yet.</p>}
          <ul className="loc-list">
            {users.map((u) => (
              <li key={u.id} className="inline">
                <span>
                  {u.name ? `${u.name}, ` : ""}
                  <span className="mono">{u.email}</span>
                </span>
                <span className={`pill ${u.disabled ? "muted" : "ok"}`}>{u.disabled ? "Off" : u.last_login_at ? "Signed in before" : "Not signed in yet"}</span>
                {roles && (
                  <select aria-label={`Role for ${u.name || u.email}`} value={u.role} onChange={(e) => setRole(u, e.target.value)}>
                    <option value="manager">Manager</option>
                    <option value="worker">Worker</option>
                  </select>
                )}
                <button type="button" className="btn ghost sm" onClick={() => toggle(u)}>
                  {u.disabled ? "Turn on" : "Turn off"}
                </button>
              </li>
            ))}
          </ul>
          <form className="form" onSubmit={save} aria-label={`Add a login for ${dealer.name}`}>
            <div className="three">
              <label htmlFor={`ue-${dealer.id}`}>
                Email
                <input id={`ue-${dealer.id}`} type="email" autoComplete="off" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
              </label>
              <label htmlFor={`un-${dealer.id}`}>
                Name
                <input id={`un-${dealer.id}`} maxLength={80} autoComplete="off" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
              </label>
              <label htmlFor={`up-${dealer.id}`}>
                Password <span className="hint">(10 or more)</span>
                <input id={`up-${dealer.id}`} type="text" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
              </label>
            </div>
            {roles && (
              <label htmlFor={`ur-${dealer.id}`}>
                Role
                <select id={`ur-${dealer.id}`} value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
                  <option value="worker">Worker: pulls, packs, ships and counts</option>
                  <option value="manager">Manager: also approves, overrides and sets shop rules</option>
                </select>
              </label>
            )}
            <p className="hint">Using an email that&apos;s already here sets a new password for it and leaves its role as it is.</p>
            <div className="inline">
              <button type="submit" className="btn sm" disabled={busy || !f.email || f.password.length < 10}>
                {busy ? "Saving…" : "Save login"}
              </button>
            </div>
          </form>
        </>
      )}
    </div>
  );
}

/** A dealer's own branded store: shown at their web address, selling only their stock. */
function StorefrontBlock({ dealer, data, act, say }: { dealer: Dealer; data: AdminData; act: Act; say: Say }) {
  const sf = (data.storefronts ?? []).find((x) => x.dealer_id === dealer.id);
  const [open, setOpen] = useState(false);
  if (!sf && !open) {
    return (
      <button type="button" className="btn ghost sm" onClick={() => setOpen(true)}>
        Set up a branded store for {dealer.name}
      </button>
    );
  }
  return <StorefrontForm key={sf?.id ?? "new"} dealer={dealer} sf={sf} act={act} say={say} onCancel={sf ? undefined : () => setOpen(false)} />;
}

function StorefrontForm({
  dealer,
  sf,
  act,
  say,
  onCancel,
}: {
  dealer: Dealer;
  sf?: Storefront;
  act: Act;
  say: Say;
  onCancel?: () => void;
}) {
  const id = sf?.id ?? `new-${dealer.id}`;
  const [f, setF] = useState({
    name: sf?.name ?? dealer.name,
    host: sf?.host ?? "",
    tagline: sf?.tagline ?? "",
    phone: sf?.phone ?? "",
    email: sf?.email ?? "",
    logo_url: sf?.logo_url ?? "",
    color_header: sf?.color_header ?? "#1a1a1a",
    color_accent: sf?.color_accent ?? "#e81820",
    color_button: sf?.color_button ?? "#b3121a",
    live: sf?.live ?? false,
    stock_scope: sf?.stock_scope ?? "own",
    location_filter: sf?.location_filter ?? false,
    ship_own: sf?.ship_own ?? false,
    ship_flat: centsText(sf?.ship_flat_cents ?? 800),
    free_over: sf?.free_ship_over_cents != null ? centsText(sf.free_ship_over_cents) : "",
    order_min: centsText(sf?.order_min_cents ?? 0),
  });
  const [busy, setBusy] = useState(false);
  const set = (k: Exclude<keyof typeof f, "live" | "location_filter" | "ship_own">) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF({ ...f, [k]: e.target.value });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const flat = dollarsToCents(f.ship_flat);
    const free = dollarsToCents(f.free_over);
    const min = dollarsToCents(f.order_min);
    if (f.ship_own) {
      if (flat == null || Number.isNaN(flat)) return say("Enter the shipping charge per order, like 12.00. Use 0 for free shipping.", true);
      if (Number.isNaN(free)) return say("Free shipping over: enter an amount like 150.00, or leave it blank.", true);
      if (Number.isNaN(min)) return say("Order minimum: enter an amount like 15.00, or leave it blank for none.", true);
    }
    const { ship_flat, free_over, order_min, ...rest } = f;
    void ship_flat;
    void free_over;
    void order_min;
    setBusy(true);
    const done = await act("storefront.save", {
      ...rest,
      ship_flat_cents: flat != null && !Number.isNaN(flat) ? flat : 0,
      free_ship_over_cents: free != null && !Number.isNaN(free) ? free : null,
      order_min_cents: min != null && !Number.isNaN(min) ? min : 0,
      dealer_id: dealer.id,
      ...(sf ? { storefront_id: sf.id } : {}),
    });
    setBusy(false);
    if (done) {
      say(done.options_saved === false ? "Store saved. Stock and shipping choices need a database update first." : sf ? "Store saved" : `Set up ${f.name.trim()}'s store`);
    }
  }

  const color = (k: "color_header" | "color_accent" | "color_button", label: string) => (
    <label htmlFor={`${k}-${id}`}>
      {label}
      <span className="sf-color">
        <input type="color" aria-label={`${label}, picker`} value={f[k]} onChange={set(k)} />
        <input id={`${k}-${id}`} maxLength={7} autoComplete="off" value={f[k]} onChange={set(k)} />
      </span>
    </label>
  );

  return (
    <form className="form loc-form sf-form" onSubmit={save} aria-label={`${dealer.name} branded store`}>
      <h3>Branded store</h3>
      <p className="hint">
        Shows {dealer.name}&apos;s name, logo and colors at their own web address, and sells only the parts at their locations.
        Orders are filled from their shelves.
      </p>
      <div className="two">
        <label htmlFor={`sfn-${id}`}>
          Store name
          <input id={`sfn-${id}`} maxLength={60} autoComplete="off" value={f.name} onChange={set("name")} />
        </label>
        <label htmlFor={`sfh-${id}`}>
          Web address
          <input id={`sfh-${id}`} maxLength={120} autoComplete="off" placeholder="parts.example.com" value={f.host} onChange={set("host")} />
        </label>
      </div>
      <label htmlFor={`sft-${id}`}>
        Headline (optional)
        <input id={`sft-${id}`} maxLength={90} autoComplete="off" value={f.tagline} onChange={set("tagline")} />
      </label>
      <div className="two">
        <label htmlFor={`sfp-${id}`}>
          Customer phone
          <input id={`sfp-${id}`} maxLength={30} autoComplete="off" value={f.phone} onChange={set("phone")} />
        </label>
        <label htmlFor={`sfe-${id}`}>
          Customer email
          <input id={`sfe-${id}`} maxLength={80} autoComplete="off" value={f.email} onChange={set("email")} />
        </label>
      </div>
      <label htmlFor={`sfl-${id}`}>
        Logo
        <input id={`sfl-${id}`} maxLength={300} autoComplete="off" placeholder="/brands/name.png or https://…" value={f.logo_url} onChange={set("logo_url")} />
      </label>
      <div className="three">
        {color("color_header", "Header")}
        {color("color_accent", "Stripe")}
        {color("color_button", "Buttons")}
      </div>
      <fieldset className="sf-choice">
        <legend>Parts to show</legend>
        <label>
          <input type="radio" name={`scope-${id}`} checked={f.stock_scope === "own"} onChange={() => setF({ ...f, stock_scope: "own" })} />
          Only {dealer.name}&apos;s own stock
        </label>
        <label>
          <input type="radio" name={`scope-${id}`} checked={f.stock_scope === "network"} onChange={() => setF({ ...f, stock_scope: "network" })} />
          Every part on Backroad Iron
        </label>
        <p className="hint">
          With every part, orders use {dealer.name}&apos;s shelves first. A part from another dealer&apos;s shelf ships from there.
        </p>
        <label>
          <input type="checkbox" checked={f.location_filter} onChange={(e) => setF({ ...f, location_filter: e.target.checked })} />
          Let shoppers pick a location and see only the parts on the shelf there
        </label>
      </fieldset>
      <fieldset className="sf-choice">
        <legend>Shipping</legend>
        <label>
          <input type="radio" name={`ship-${id}`} checked={!f.ship_own} onChange={() => setF({ ...f, ship_own: false })} />
          Use Backroad Iron&apos;s shipping charges
        </label>
        <label>
          <input type="radio" name={`ship-${id}`} checked={f.ship_own} onChange={() => setF({ ...f, ship_own: true })} />
          Set {dealer.name}&apos;s own
        </label>
        {f.ship_own && (
          <div className="three">
            <label htmlFor={`sfs-${id}`}>
              Shipping per order $
              <input id={`sfs-${id}`} inputMode="decimal" autoComplete="off" placeholder="12.00" value={f.ship_flat} onChange={set("ship_flat")} />
            </label>
            <label htmlFor={`sff-${id}`}>
              Free shipping over $
              <input id={`sff-${id}`} inputMode="decimal" autoComplete="off" placeholder="Blank for never" value={f.free_over} onChange={set("free_over")} />
            </label>
            <label htmlFor={`sfm-${id}`}>
              Order minimum $
              <input id={`sfm-${id}`} inputMode="decimal" autoComplete="off" placeholder="0.00" value={f.order_min} onChange={set("order_min")} />
            </label>
          </div>
        )}
      </fieldset>
      <div className="loc-ticks">
        <label>
          <input type="checkbox" checked={f.live} onChange={(e) => setF({ ...f, live: e.target.checked })} /> Open to shoppers at the web address
        </label>
      </div>
      <div className="inline">
        <button type="submit" className="btn sm" disabled={busy}>
          {busy ? "Saving…" : sf ? "Save store" : "Set up store"}
        </button>
        {sf && (
          <a className="btn ghost sm" href={`/?storefront=${sf.slug}`} target="_blank" rel="noopener">
            Preview
          </a>
        )}
        {onCancel && (
          <button type="button" className="btn ghost sm" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

/** Backroad Iron orders sent to dealers who opt in, and Backroad Iron's cut. */
function RoutingBlock({ data, act, say }: Props) {
  const r = data.routing;
  const [f, setF] = useState({
    route_orders: r.route_orders,
    cut: bpsToPercent(r.route_cut_bps),
    network: bpsToPercent(r.network_fee_bps),
    fee: bpsToPercent(r.storefront_fee_bps),
    house: r.house_dealer_id ?? data.places.dealers[0]?.id ?? "",
  });
  const [busy, setBusy] = useState(false);
  const opted = data.places.locations.filter((l) => l.takes_routed && l.dealer_id !== f.house);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const cut = percentToBps(f.cut);
    const network = percentToBps(f.network);
    const fee = percentToBps(f.fee);
    if (Number.isNaN(cut)) return say("The selling share is a percent from 0 to 50, like 6.", true);
    if (Number.isNaN(network)) return say("The network fee is a percent from 0 to 50, like 2.", true);
    if (Number.isNaN(fee)) return say("The own-store fee is a percent from 0 to 50. Use 0 for none.", true);
    setBusy(true);
    const done = await act("routing.save", {
      route_orders: f.route_orders,
      route_cut_bps: cut,
      network_fee_bps: network,
      storefront_fee_bps: fee,
      house_dealer_id: f.house,
    });
    setBusy(false);
    if (done) say(f.route_orders ? "Routing saved. Backroad Iron orders now go to dealers who take them." : "Routing saved. It's off.");
  }

  return (
    <form className="form loc-form route-form" onSubmit={save} aria-label="Routing Backroad Iron orders">
      <h3>Backroad Iron orders filled by dealers</h3>
      <p className="hint">
        When a Backroad Iron customer orders a part a dealer has, the dealer nearest them (same ZIP area, then same state) can ship it. Only
        locations set to &quot;Takes Backroad Iron orders&quot; are used. Counter pickups stay at Backroad Iron.
      </p>
      <p className="hint">
        Whoever makes the sale earns the selling share; whoever ships gets the rest, the shipping, and pays its share of the card fee. When
        one dealer&apos;s store sells and another dealer ships, Backroad Iron also keeps the network fee.
      </p>
      <label className="check-row" htmlFor="rt-on">
        <input id="rt-on" type="checkbox" checked={f.route_orders} onChange={(e) => setF({ ...f, route_orders: e.target.checked })} />
        Send Backroad Iron orders to dealers who take them
      </label>
      <p className="hint">
        {opted.length
          ? `Taking orders now: ${opted.map((l) => l.name).join(", ")}.`
          : "No dealer location takes Backroad Iron orders yet. Tick it on a location below."}
      </p>
      <div className="three">
        <label htmlFor="rt-cut">
          Selling share %, both ways
          <input id="rt-cut" inputMode="decimal" autoComplete="off" value={f.cut} onChange={(e) => setF({ ...f, cut: e.target.value })} />
        </label>
        <label htmlFor="rt-net">
          Network fee % (dealer to dealer)
          <input id="rt-net" inputMode="decimal" autoComplete="off" value={f.network} onChange={(e) => setF({ ...f, network: e.target.value })} />
        </label>
        <label htmlFor="rt-fee">
          Fee on a dealer&apos;s own-store sales %
          <input id="rt-fee" inputMode="decimal" autoComplete="off" value={f.fee} onChange={(e) => setF({ ...f, fee: e.target.value })} />
        </label>
        <label htmlFor="rt-house">
          Backroad Iron is
          <select id="rt-house" value={f.house} onChange={(e) => setF({ ...f, house: e.target.value })}>
            {data.places.dealers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <button type="submit" className="btn sm" disabled={busy}>
        {busy ? "Saving…" : "Save routing"}
      </button>
    </form>
  );
}
