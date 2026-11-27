"use client";
// Dealers and their store locations: where parts are kept and sold from.
import { useState } from "react";
import type { AdminData } from "@/lib/admin-types";
import { normCode, type Dealer, type StoreLocation } from "@/lib/places";
import type { Storefront } from "@/lib/storefront";
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
            <LocationForm dealerId={dealer.id} loc={l} isDefault={data.places.default_location_id === l.id} act={act} say={say} />
          </li>
        ))}
      </ul>
      {adding ? (
        <LocationForm dealerId={dealer.id} isDefault={false} act={act} say={say} onDone={() => setAdding(false)} />
      ) : (
        <button type="button" className="btn ghost sm" onClick={() => setAdding(true)}>
          Add a location for {dealer.name}
        </button>
      )}
      <StorefrontBlock dealer={dealer} data={data} act={act} say={say} />
    </section>
  );
}

export function LocationForm({
  dealerId,
  loc,
  isDefault,
  act,
  say,
  onDone,
  onSaved,
}: {
  dealerId: string;
  loc?: StoreLocation;
  isDefault: boolean;
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
  });
  const [busy, setBusy] = useState(false);
  const set = (k: "name" | "code" | "city" | "state" | "zip") => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF({ ...f, [k]: k === "code" ? normCode(e.target.value) : k === "state" ? e.target.value.toUpperCase().slice(0, 2) : e.target.value });
  const tick = (k: "ships" | "pickup" | "active" | "make_default") => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF({ ...f, [k]: e.target.checked });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const done = await act("location.save", { ...f, dealer_id: dealerId, ...(loc ? { location_id: loc.id } : {}) });
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
  });
  const [busy, setBusy] = useState(false);
  const set = (k: Exclude<keyof typeof f, "live">) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const done = await act("storefront.save", { ...f, dealer_id: dealer.id, ...(sf ? { storefront_id: sf.id } : {}) });
    setBusy(false);
    if (done) say(sf ? "Store saved" : `Set up ${f.name.trim()}'s store`);
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
