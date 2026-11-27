"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ActionReply, AdminData } from "@/lib/admin-types";
import { HOME_TAB, NAV_GROUPS, TAB_NAMES, groupOf, groupTarget, tabFromHash, type Tab } from "@/lib/admin-nav";
import Alerts from "./admin/Alerts";
import Counter from "./admin/Counter";
import Home from "./admin/Home";
import Hoses from "./admin/Hoses";
import Inventory from "./admin/Inventory";
import Locations from "./admin/Locations";
import Machines from "./admin/Machines";
import Orders from "./admin/Orders";
import Quotes from "./admin/Quotes";
import SettingsTab from "./admin/SettingsTab";
import Statements from "./admin/Statements";
import SpaceMapper from "./admin/SpaceMapper";
import Spots from "./admin/Spots";
import SupplierPhotos from "./admin/SupplierPhotos";
import Survey from "./admin/Survey";
import { Toast, type ToastState } from "./ui";

export type Act = (action: string, payload?: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
export type Say = (text: string, bad?: boolean) => void;

// Pages that load their own data and don't wait on the store's.
const OWN_DATA: Tab[] = ["survey", "photos", "machines", "hoses", "spacemap"];

export default function Admin() {
  const router = useRouter();
  const [data, setData] = useState<AdminData | null>(null);
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState<Tab>(HOME_TAB);
  // The page last open in each group, so pressing a group goes back to where you were.
  const lastIn = useRef<Partial<Record<string, Tab>>>({});

  // The address's "#page" picks the page: a reload stays put, and Back goes to the page before.
  useEffect(() => {
    const read = () => {
      const t = tabFromHash(window.location.hash) ?? HOME_TAB;
      lastIn.current[groupOf(t).id] = t;
      setTab(t);
    };
    const first = setTimeout(read, 0);
    window.addEventListener("hashchange", read);
    return () => {
      clearTimeout(first);
      window.removeEventListener("hashchange", read);
    };
  }, []);

  // On a phone the open group's pages sit on one sliding line: keep the open page in view.
  useEffect(() => {
    document.querySelector('.nav-sub [aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tab]);

  const go = useCallback((t: Tab) => {
    lastIn.current[groupOf(t).id] = t;
    setTab(t);
    if (tabFromHash(window.location.hash) !== t) window.location.hash = t;
    window.scrollTo({ top: 0 });
  }, []);
  const [toast, setToast] = useState<ToastState>(null);

  const say = useCallback<Say>((text, bad = false) => setToast({ text, bad, at: Date.now() }), []);
  const clearToast = useCallback(() => setToast(null), []);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/admin", { cache: "no-store" });
      const reply = (await res.json()) as ActionReply;
      if (reply.ok) setData(reply.data);
      else if (res.status === 401) router.refresh();
      else setLoadError(reply.message);
    } catch {
      setLoadError("The store data could not be reached. Check your connection and reload.");
    }
  }, [router]);

  useEffect(() => {
    // Initial load; state is only set after the request settles.
    const t = setTimeout(reload, 0);
    return () => clearTimeout(t);
  }, [reload]);

  const act = useCallback<Act>(
    async (action, payload = {}) => {
      try {
        const res = await fetch("/api/admin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, action }),
        });
        const reply = (await res.json()) as ActionReply;
        if (reply.ok) {
          setData(reply.data);
          return reply.result ?? {};
        }
        say(reply.message, true);
        if (res.status === 401) router.refresh();
        return null;
      } catch {
        say("That change did not save. Check your connection and try again.", true);
        return null;
      }
    },
    [router, say],
  );

  async function signOut() {
    await fetch("/api/admin/login", { method: "DELETE" }).catch(() => undefined);
    router.refresh();
  }

  const toShip = data ? data.orders.filter((o) => o.status === "paid").length : 0;
  const group = groupOf(tab);

  return (
    <>
      <header className="top admin-top">
        <div className="wrap">
          <a className="brand" href="#home">
            Back office
          </a>
          <div className="nav-util">
            <Link href="/">View shop</Link>
            <button type="button" className="tab" onClick={signOut}>
              Sign out
            </button>
          </div>
          <nav aria-label="Back office" className="nav-groups">
            {NAV_GROUPS.map((g) => (
              <button
                key={g.id}
                type="button"
                className="tab"
                aria-current={g.id === group.id ? "true" : undefined}
                onClick={() => go(groupTarget(g, lastIn.current))}
              >
                {g.name}
                {g.tabs.includes("orders") && toShip > 0 && (
                  <span className="count" aria-label={`${toShip} order${toShip === 1 ? "" : "s"} to ship`}>
                    {toShip}
                  </span>
                )}
              </button>
            ))}
          </nav>
        </div>
        {group.tabs.length > 1 && (
          <div className="nav-sub">
            <div className="wrap">
              <nav aria-label={`${group.name} pages`}>
                {group.tabs.map((t) => (
                  <button key={t} type="button" className="tab" aria-current={tab === t ? "page" : undefined} onClick={() => go(t)}>
                    {t === "orders" && toShip ? `Orders (${toShip})` : TAB_NAMES[t]}
                  </button>
                ))}
              </nav>
            </div>
          </div>
        )}
      </header>
      <main className="wrap">
        {tab === "hoses" && <Hoses say={say} />}
        {tab === "machines" && <Machines say={say} />}
        {tab === "survey" && <Survey say={say} />}
        {tab === "photos" && <SupplierPhotos say={say} />}
        {tab === "spacemap" && <SpaceMapper say={say} />}
        {!data && !loadError && !OWN_DATA.includes(tab) && <p className="empty">Loading the store…</p>}
        {loadError && !OWN_DATA.includes(tab) && (
          <p className="empty err" role="alert">
            {loadError}
          </p>
        )}
        {data && tab === "home" && <Home data={data} act={act} go={go} reload={reload} />}
        {data && tab === "inventory" && <Inventory data={data} act={act} say={say} reload={reload} />}
        {data && tab === "counter" && <Counter data={data} act={act} say={say} />}
        {data && tab === "alerts" && <Alerts data={data} act={act} say={say} />}
        {data && tab === "spots" && <Spots products={data.products} say={say} />}
        {data && tab === "orders" && <Orders data={data} act={act} say={say} />}
        {data && tab === "statements" && <Statements data={data} act={act} say={say} />}
        {data && tab === "quotes" && <Quotes data={data} act={act} say={say} />}
        {data && tab === "dealers" && (
          <>
            <div className="inv-head">
              <div>
                <p className="eyebrow">Back office</p>
                <h1>Dealers</h1>
              </div>
            </div>
            {/* Saved on its own: each location has its own Save button. */}
            <Locations data={data} act={act} say={say} />
          </>
        )}
        {data && tab === "settings" && <SettingsTab data={data} act={act} say={say} go={() => go("dealers")} />}
      </main>
      <Toast toast={toast} clear={clearToast} />
    </>
  );
}
