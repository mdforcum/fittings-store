"use client";
import { useState } from "react";
import type { AdminData, Mode, ParcelPreset } from "@/lib/admin-types";
import { SHIP_ZONES, dollars, toCents } from "@/lib/catalog";
import type { Act, Say } from "../Admin";
import Locations from "./Locations";

type Props = { data: AdminData; act: Act; say: Say };
type PresetDraft = { name: string; length: string; width: string; height: string; weight_oz: string };

const draft = (p: ParcelPreset): PresetDraft => ({
  name: p.name,
  length: String(p.length),
  width: String(p.width),
  height: String(p.height),
  weight_oz: String(p.weight_oz),
});

const modeText = (m: Mode) => (m === null ? "Not connected" : m === "test" ? "Connected, test mode" : "Connected, live");
const modeTone = (m: Mode) => (m === null ? "bad" : m === "test" ? "hold" : "ok");

export default function SettingsTab({ data, act, say }: Props) {
  const s = data.settings;
  const [store, setStore] = useState({
    store_name: s.store_name,
    tagline: s.tagline,
    phone: s.phone,
    email: s.email,
    low_stock: String(s.low_stock),
    shipping: dollars(s.shipping_flat_cents),
    minimum: dollars(s.order_min_cents),
    free_over: dollars(s.free_ship_over_cents),
    cutoff: s.ship_cutoff,
    tz: s.ship_tz,
    hold: String(s.hold_minutes),
  });
  const [from, setFrom] = useState(data.config.ship_from);
  const [presets, setPresets] = useState<PresetDraft[]>(data.config.presets.map(draft));
  const [taxMode, setTaxMode] = useState(data.config.tax_mode);
  const [labelFormat, setLabelFormat] = useState(data.config.label_format);
  const [busy, setBusy] = useState(false);

  const st = (key: keyof typeof store) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setStore((cur) => ({ ...cur, [key]: e.target.value }));
  const fr = (key: keyof typeof from) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setFrom((cur) => ({ ...cur, [key]: e.target.value }));
  const pr = (i: number, key: keyof PresetDraft) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setPresets((cur) => cur.map((p, j) => (j === i ? { ...p, [key]: e.target.value } : p)));

  async function save() {
    const shipping = toCents(store.shipping);
    const minimum = toCents(store.minimum);
    const freeOver = toCents(store.free_over);
    const low = Number(store.low_stock);
    if (shipping == null || Number.isNaN(shipping) || shipping < 0) return say("Enter the shipping fee as a dollar amount.", true);
    if (minimum == null || Number.isNaN(minimum) || minimum < 0) return say("Enter the order minimum as a dollar amount (0 for none).", true);
    if (Number.isNaN(freeOver) || (freeOver != null && freeOver < 0)) return say("Free shipping amount must be a dollar amount, or blank.", true);
    if (!Number.isInteger(low) || low < 0) return say("The low-stock number must be a whole number.", true);
    if (!/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(store.cutoff.trim())) return say("Give the same-day cutoff as a time, like 14:00.", true);
    const hold = Number(store.hold);
    if (!Number.isInteger(hold) || hold < 30 || hold > 1440) return say("Hold parts in checkout for 30 to 1440 minutes.", true);
    setBusy(true);
    const done = await act("settings.save", {
      settings: {
        store_name: store.store_name,
        tagline: store.tagline,
        phone: store.phone,
        email: store.email,
        low_stock: low,
        shipping_flat_cents: shipping,
        order_min_cents: minimum,
        free_ship_over_cents: freeOver,
        ship_cutoff: store.cutoff.trim(),
        ship_tz: store.tz,
        hold_minutes: hold,
      },
      config: {
        ship_from: from,
        presets: presets.map((p) => ({
          name: p.name,
          length: Number(p.length),
          width: Number(p.width),
          height: Number(p.height),
          weight_oz: Number(p.weight_oz),
        })),
        tax_mode: taxMode,
        label_format: labelFormat,
      },
    });
    setBusy(false);
    if (done) say("Settings saved");
  }

  async function connectWebhook() {
    setBusy(true);
    const done = await act("stripe.webhook");
    setBusy(false);
    if (done) say("Stripe is now reporting paid orders to this site");
  }

  const { stripe, webhook, shippo } = data.integrations;

  return (
    <>
      <div className="inv-head">
        <div>
          <p className="eyebrow">Back office</p>
          <h1>Settings</h1>
        </div>
        <button type="button" className="btn" disabled={busy} onClick={save}>
          Save settings
        </button>
      </div>

      <div className="card">
        <h2>Payments and labels</h2>
        <div className="status">
          <div>
            <span>Stripe payments</span>
            <span className={`pill ${modeTone(stripe)}`}>{modeText(stripe)}</span>
          </div>
          <div>
            <span>Stripe order reporting</span>
            {webhook ? (
              <span className="pill ok">Connected</span>
            ) : (
              <button type="button" className="btn sm" disabled={busy || stripe === null} onClick={connectWebhook}>
                Connect
              </button>
            )}
          </div>
          <div>
            <span>Shippo labels</span>
            <span className={`pill ${modeTone(shippo)}`}>{modeText(shippo)}</span>
          </div>
        </div>
        <p className="hint">
          Keys are added in Vercel under Project, Settings, Environment Variables (STRIPE_SECRET_KEY and
          SHIPPO_API_TOKEN), then a redeploy. Press Connect from the web address customers will use, since Stripe
          reports paid orders back to that address.
          {webhook && stripe !== null && " If you change the site's address or switch Stripe from test to live, connect again: "}
          {webhook && stripe !== null && (
            <button type="button" className="linkbtn" disabled={busy} onClick={connectWebhook}>
              reconnect order reporting
            </button>
          )}
        </p>
      </div>

      <div className="card">
        <h2>Store details</h2>
        <div className="form">
          <div className="two">
            <label htmlFor="s-name">
              Store name
              <input id="s-name" maxLength={60} autoComplete="off" value={store.store_name} onChange={st("store_name")} />
            </label>
            <label htmlFor="s-low">
              Show &quot;only N left&quot; at or below
              <input id="s-low" inputMode="numeric" autoComplete="off" value={store.low_stock} onChange={st("low_stock")} />
            </label>
          </div>
          <label htmlFor="s-hold">
            Hold parts in checkout for (minutes)
            <input id="s-hold" inputMode="numeric" autoComplete="off" value={store.hold} onChange={st("hold")} aria-describedby="s-hold-help" />
            <span className="hint" id="s-hold-help">
              From the moment a shopper starts checkout, nobody else can buy those parts. Stripe allows 30 to 1440 (24 hours).
            </span>
          </label>
          <label htmlFor="s-tagline">
            Headline
            <input id="s-tagline" maxLength={90} autoComplete="off" value={store.tagline} onChange={st("tagline")} />
          </label>
          <div className="two">
            <label htmlFor="s-phone">
              Customer phone
              <input id="s-phone" maxLength={30} autoComplete="off" value={store.phone} onChange={st("phone")} />
            </label>
            <label htmlFor="s-email">
              Customer email
              <input id="s-email" maxLength={80} autoComplete="off" value={store.email} onChange={st("email")} />
            </label>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Shipping charge and tax</h2>
        <div className="form">
          <div className="two">
            <label htmlFor="s-ship">
              Flat shipping fee $
              <input id="s-ship" inputMode="decimal" autoComplete="off" value={store.shipping} onChange={st("shipping")} />
            </label>
            <label htmlFor="s-min">
              Order minimum $
              <input id="s-min" inputMode="decimal" autoComplete="off" value={store.minimum} onChange={st("minimum")} />
            </label>
            <label htmlFor="s-free">
              Free shipping over $ (blank = never)
              <input id="s-free" inputMode="decimal" autoComplete="off" value={store.free_over} onChange={st("free_over")} />
            </label>
            <label htmlFor="s-cutoff">
              Same-day cutoff (24-hour time)
              <input id="s-cutoff" type="time" autoComplete="off" value={store.cutoff} onChange={st("cutoff")} />
            </label>
            <label htmlFor="s-tz">
              Cutoff time zone
              <select id="s-tz" value={store.tz} onChange={st("tz")}>
                {SHIP_ZONES.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="hint">
            In-stock orders paid before the cutoff on a weekday ship that day; the shop shows the countdown. Free shipping
            goes by the parts total: core charges don&apos;t count toward it.
          </p>
          <label htmlFor="s-tax">
            Sales tax
            <select id="s-tax" value={taxMode} onChange={(e) => setTaxMode(e.target.value === "stripe" ? "stripe" : "off")}>
              <option value="off">Not collected at checkout</option>
              <option value="stripe">Collected by Stripe Tax (set up in Stripe first)</option>
            </select>
          </label>
          <p className="hint">
            Stripe Tax is a paid Stripe add-on that needs your tax registrations entered in Stripe. Leave tax off
            here until your accountant confirms what to collect.
          </p>
        </div>
      </div>

      <div className="card">
        <h2>Ship-from address</h2>
        <div className="form">
          <div className="two">
            <label htmlFor="a-name">
              Name
              <input id="a-name" autoComplete="off" value={from.name} onChange={fr("name")} />
            </label>
            <label htmlFor="a-co">
              Company
              <input id="a-co" autoComplete="off" value={from.company} onChange={fr("company")} />
            </label>
          </div>
          <label htmlFor="a-s1">
            Street
            <input id="a-s1" autoComplete="off" value={from.street1} onChange={fr("street1")} />
          </label>
          <label htmlFor="a-s2">
            Suite or unit
            <input id="a-s2" autoComplete="off" value={from.street2} onChange={fr("street2")} />
          </label>
          <div className="two">
            <label htmlFor="a-city">
              City
              <input id="a-city" autoComplete="off" value={from.city} onChange={fr("city")} />
            </label>
            <label htmlFor="a-state">
              State
              <input id="a-state" maxLength={2} autoComplete="off" placeholder="IL" value={from.state} onChange={fr("state")} />
            </label>
            <label htmlFor="a-zip">
              ZIP
              <input id="a-zip" inputMode="numeric" autoComplete="off" value={from.zip} onChange={fr("zip")} />
            </label>
          </div>
          <div className="two">
            <label htmlFor="a-phone">
              Phone (carriers require one)
              <input id="a-phone" autoComplete="off" value={from.phone} onChange={fr("phone")} />
            </label>
            <label htmlFor="a-email">
              Email
              <input id="a-email" autoComplete="off" value={from.email} onChange={fr("email")} />
            </label>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Packages and labels</h2>
        <div className="form">
          <p className="hint">Saved package sizes fill in the label form with one tap. Weight is the usual packed weight.</p>
          {presets.map((p, i) => (
            <div className="preset-row" key={i}>
              <label htmlFor={`p-name-${i}`}>
                Name
                <input id={`p-name-${i}`} autoComplete="off" value={p.name} onChange={pr(i, "name")} />
              </label>
              <label htmlFor={`p-l-${i}`}>
                L in
                <input id={`p-l-${i}`} inputMode="decimal" value={p.length} onChange={pr(i, "length")} />
              </label>
              <label htmlFor={`p-w-${i}`}>
                W in
                <input id={`p-w-${i}`} inputMode="decimal" value={p.width} onChange={pr(i, "width")} />
              </label>
              <label htmlFor={`p-h-${i}`}>
                H in
                <input id={`p-h-${i}`} inputMode="decimal" value={p.height} onChange={pr(i, "height")} />
              </label>
              <label htmlFor={`p-oz-${i}`}>
                Oz
                <input id={`p-oz-${i}`} inputMode="decimal" value={p.weight_oz} onChange={pr(i, "weight_oz")} />
              </label>
              <button
                type="button"
                className="btn ghost sm"
                aria-label={`Remove ${p.name || "package"}`}
                onClick={() => setPresets((cur) => cur.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            </div>
          ))}
          <div>
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => setPresets((cur) => [...cur, { name: "", length: "", width: "", height: "", weight_oz: "" }])}
            >
              Add a package size
            </button>
          </div>
          <label htmlFor="s-label">
            Label format
            <select
              id="s-label"
              value={labelFormat}
              onChange={(e) => setLabelFormat(e.target.value === "PDF_4x6" ? "PDF_4x6" : "PDF")}
            >
              <option value="PDF">Plain paper (letter size)</option>
              <option value="PDF_4x6">4×6 label printer</option>
            </select>
          </label>
        </div>
      </div>

      <p style={{ margin: "0 0 48px" }}>
        <button type="button" className="btn" disabled={busy} onClick={save}>
          Save settings
        </button>
      </p>

      {/* Saved on its own: each location has its own Save button. */}
      <Locations data={data} act={act} say={say} />
    </>
  );
}
