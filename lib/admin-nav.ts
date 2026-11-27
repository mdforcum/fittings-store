// The back office's pages, grouped the way a day at the shop runs: sell, keep
// stock, keep the catalog, work with dealers, settings. The header shows the
// groups; the row under it shows the pages of the group that is open.

export const TAB_NAMES = {
  home: "Home",
  orders: "Orders",
  counter: "Counter sale",
  quotes: "Quotes",
  hoses: "Hoses",
  inventory: "Inventory",
  alerts: "Running low",
  spots: "Shelf map",
  spacemap: "Space mapper",
  survey: "Survey",
  machines: "Machines",
  photos: "Supplier photos",
  dealers: "Dealers and locations",
  statements: "Dealer pay",
  settings: "Settings",
} as const;

export type Tab = keyof typeof TAB_NAMES;
export type NavGroup = { id: string; name: string; tabs: Tab[] };

export const NAV_GROUPS: NavGroup[] = [
  { id: "home", name: "Home", tabs: ["home"] },
  { id: "sell", name: "Sell", tabs: ["orders", "counter", "quotes", "hoses"] },
  { id: "stock", name: "Stock", tabs: ["inventory", "alerts", "spots", "spacemap", "survey"] },
  { id: "catalog", name: "Catalog", tabs: ["machines", "photos"] },
  { id: "dealers", name: "Dealers", tabs: ["dealers", "statements"] },
  { id: "settings", name: "Settings", tabs: ["settings"] },
];

export const HOME_TAB: Tab = "home";

export const isTab = (v: unknown): v is Tab => typeof v === "string" && Object.prototype.hasOwnProperty.call(TAB_NAMES, v);

/** The group a page belongs to. */
export function groupOf(tab: Tab): NavGroup {
  return NAV_GROUPS.find((g) => g.tabs.includes(tab)) ?? NAV_GROUPS[0];
}

/** The page named by the address's "#…" part, so a page can be bookmarked and survives a reload. */
export function tabFromHash(hash: string): Tab | null {
  const id = hash.replace(/^#/, "").trim().toLowerCase();
  return isTab(id) ? id : null;
}

/** Where pressing a group goes: the page last open in that group, else its first. */
export function groupTarget(group: NavGroup, last: Partial<Record<string, Tab>>): Tab {
  const was = last[group.id];
  return was && group.tabs.includes(was) ? was : group.tabs[0];
}

// Shortcuts: the pages a person pins to Home. Kept in the browser, so each
// device has its own until the back office has named logins.

export const SHORTCUTS_KEY = "backoffice-shortcuts";
export const SHORTCUT_LIMIT = 8;
export const DEFAULT_SHORTCUTS: Tab[] = ["orders", "counter", "inventory", "alerts"];

/** Reads saved shortcuts; anything unreadable falls back to the starting set. Home is never its own shortcut. */
export function readShortcuts(raw: string | null | undefined): Tab[] {
  if (!raw) return DEFAULT_SHORTCUTS;
  try {
    const list: unknown = JSON.parse(raw);
    if (!Array.isArray(list)) return DEFAULT_SHORTCUTS;
    const out: Tab[] = [];
    for (const v of list) if (isTab(v) && v !== "home" && !out.includes(v)) out.push(v);
    return out.slice(0, SHORTCUT_LIMIT);
  } catch {
    return DEFAULT_SHORTCUTS;
  }
}

/** Adds or removes a page from the shortcuts, keeping the order they were picked in. */
export function toggleShortcut(list: Tab[], tab: Tab): Tab[] {
  if (tab === "home") return list;
  if (list.includes(tab)) return list.filter((t) => t !== tab);
  return list.length >= SHORTCUT_LIMIT ? list : [...list, tab];
}
