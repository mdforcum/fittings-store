"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { ActionReply, AdminData } from "@/lib/admin-types";
import Hoses from "./admin/Hoses";
import Inventory from "./admin/Inventory";
import Machines from "./admin/Machines";
import Orders from "./admin/Orders";
import Quotes from "./admin/Quotes";
import SettingsTab from "./admin/SettingsTab";
import Spots from "./admin/Spots";
import SupplierPhotos from "./admin/SupplierPhotos";
import Survey from "./admin/Survey";
import { Toast, type ToastState } from "./ui";

export type Act = (action: string, payload?: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
export type Say = (text: string, bad?: boolean) => void;

type Tab = "inventory" | "spots" | "machines" | "orders" | "quotes" | "hoses" | "survey" | "photos" | "settings";

const TAB_NAMES: Record<Tab, string> = {
  inventory: "Inventory",
  spots: "Shelf map",
  machines: "Machines",
  orders: "Orders",
  quotes: "Quotes",
  hoses: "Hoses",
  survey: "Survey",
  photos: "Supplier photos",
  settings: "Settings",
};

export default function Admin() {
  const router = useRouter();
  const [data, setData] = useState<AdminData | null>(null);
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState<Tab>("inventory");
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

  return (
    <>
      <header className="top">
        <div className="wrap">
          <Link className="brand" href="/admin">
            Back office
          </Link>
          <nav aria-label="Back office">
            {(Object.keys(TAB_NAMES) as Tab[]).map((t) => (
              <button
                key={t}
                type="button"
                className="tab"
                aria-current={tab === t ? "page" : undefined}
                onClick={() => setTab(t)}
              >
                {t === "orders" && toShip ? `Orders (${toShip})` : TAB_NAMES[t]}
              </button>
            ))}
            <Link href="/">View shop</Link>
            <button type="button" className="tab" onClick={signOut}>
              Sign out
            </button>
          </nav>
        </div>
      </header>
      <main className="wrap">
        {tab === "hoses" && <Hoses say={say} />}
        {tab === "machines" && <Machines say={say} />}
        {tab === "survey" && <Survey say={say} />}
        {tab === "photos" && <SupplierPhotos say={say} />}
        {!data && !loadError && !["survey", "photos", "machines", "hoses"].includes(tab) && <p className="empty">Loading the store…</p>}
        {loadError && !["survey", "photos", "machines", "hoses"].includes(tab) && (
          <p className="empty err" role="alert">
            {loadError}
          </p>
        )}
        {data && tab === "inventory" && <Inventory data={data} act={act} say={say} reload={reload} />}
        {data && tab === "spots" && <Spots products={data.products} say={say} />}
        {data && tab === "orders" && <Orders data={data} act={act} say={say} />}
        {data && tab === "quotes" && <Quotes data={data} act={act} say={say} />}
        {data && tab === "settings" && <SettingsTab data={data} act={act} say={say} />}
      </main>
      <Toast toast={toast} clear={clearToast} />
    </>
  );
}
