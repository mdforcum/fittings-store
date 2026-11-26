"use client";
// Dealers and their store locations: where parts are kept and sold from.
import { useState } from "react";
import type { AdminData } from "@/lib/admin-types";
import { normCode, type Dealer, type StoreLocation } from "@/lib/places";
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
    </section>
  );
}

function LocationForm({
  dealerId,
  loc,
  isDefault,
  act,
  say,
  onDone,
}: {
  dealerId: string;
  loc?: StoreLocation;
  isDefault: boolean;
  act: Act;
  say: Say;
  onDone?: () => void;
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
