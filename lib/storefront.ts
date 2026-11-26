// Storefronts: the same store under another business's name, logo and colors,
// at that business's own web address (supabase/add-storefronts.sql).
//
// The address a shopper came in on picks the storefront. No match means the
// Backroad Iron store, exactly as before. Staff can look at a storefront that
// isn't live yet with ?storefront=<slug> while signed in.

export type Storefront = {
  id: string;
  dealer_id: string | null;
  slug: string;
  host: string | null;
  name: string;
  tagline: string;
  phone: string;
  email: string;
  logo_url: string;
  color_header: string;
  color_accent: string;
  color_button: string;
  live: boolean;
};

/** What the shop page needs to dress itself; no ids beyond the dealer's. */
export type StoreLook = Pick<Storefront, "slug" | "name" | "tagline" | "phone" | "email" | "logo_url" | "color_header" | "color_accent" | "color_button"> & {
  /** True when a signed-in staff member is looking at a storefront that isn't live. */
  preview: boolean;
};

const s = (v: unknown) => (typeof v === "string" ? v : "");
const HEX = /^#[0-9a-f]{6}$/;

export function normalizeStorefront(row: Record<string, unknown>): Storefront {
  const hex = (v: unknown, d: string) => (HEX.test(s(v).toLowerCase()) ? s(v).toLowerCase() : d);
  return {
    id: s(row.id),
    dealer_id: s(row.dealer_id) || null,
    slug: s(row.slug),
    host: s(row.host) || null,
    name: s(row.name),
    tagline: s(row.tagline),
    phone: s(row.phone),
    email: s(row.email),
    logo_url: s(row.logo_url),
    color_header: hex(row.color_header, "#1a1a1a"),
    color_accent: hex(row.color_accent, "#e81820"),
    color_button: hex(row.color_button, "#b3121a"),
    live: row.live === true,
  };
}

/** The web address a request came in on, lower case, without a port or trailing dot. */
export function hostOf(raw: string | null | undefined): string {
  return (raw ?? "").trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
}

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Cleans a web address typed by staff: "https://Parts.Example.com/" → "parts.example.com". */
export function cleanHost(typed: string): string {
  return hostOf(typed.replace(/^[a-z]+:\/\//i, "").split(/[/?#]/)[0]);
}

/** Logos are our own files (/brands/…) or https images. */
export function cleanLogo(typed: string): string {
  const t = typed.trim();
  if (t === "") return "";
  if (/^\/brands\/[a-z0-9-]+\.(png|webp|svg|jpg)$/.test(t)) return t;
  if (/^https:\/\/[^\s"'<>]+$/.test(t)) return t;
  return "";
}

/** Relative luminance, for checking that text stays readable on a color. */
function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

/** What is wrong with a storefront before it is saved, in words for staff; null when it is fine. */
export function storefrontProblem(f: Pick<Storefront, "id" | "slug" | "host" | "name" | "email" | "color_header" | "color_button" | "color_accent">, others: Storefront[]): string | null {
  if (!f.name.trim() || f.name.trim().length > 60) return "Give the store a name, up to 60 letters.";
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(f.slug)) return "The store needs a short name for links, like mccormick-diesel.";
  if (f.host && !HOST.test(f.host)) return "Enter the web address like parts.example.com.";
  if (f.host && /(^|\.)backroadiron\.com$/.test(f.host)) return "That address is Backroad Iron's own. Use the dealer's address.";
  if (f.host && others.some((o) => o.id !== f.id && o.host === f.host)) return "Another store already uses that web address.";
  if (others.some((o) => o.id !== f.id && o.slug === f.slug)) return "Another store already uses that short name.";
  if (f.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) return "Check the email address.";
  if (!HEX.test(f.color_header) || !HEX.test(f.color_button)) return "Colors are written like #1a1a1a.";
  if (contrast(f.color_header, "#ffffff") < 4.5) return "The header color is too light for white text. Pick a darker one.";
  if (contrast(f.color_button, "#ffffff") < 4.5) return "The button color is too light for white text. Pick a darker one.";
  if (contrast(f.color_accent, "#ffffff") < 4.5) return "The stripe color is too light for white text on the cart button. Pick a darker one.";
  return null;
}

/** The storefront for a request: the live one at this address, or a staff preview by slug. */
export function pickStorefront(all: Storefront[], host: string, previewSlug: string | null, isStaff: boolean): StoreLook | null {
  if (isStaff && previewSlug) {
    const p = all.find((f) => f.slug === previewSlug);
    if (p) return look(p, !p.live);
  }
  const f = all.find((x) => x.host === host && x.live);
  return f ? look(f, false) : null;
}

function look(f: Storefront, preview: boolean): StoreLook {
  return {
    slug: f.slug,
    name: f.name,
    tagline: f.tagline,
    phone: f.phone,
    email: f.email,
    logo_url: f.logo_url,
    color_header: f.color_header,
    color_accent: f.color_accent,
    color_button: f.color_button,
    preview,
  };
}

/** CSS variables that recolor the shop for a storefront. */
export function lookStyle(l: StoreLook): Record<string, string> {
  return {
    "--lid": l.color_header,
    "--on-lid": "#ffffff",
    "--zinc": l.color_accent,
    "--on-zinc": "#ffffff",
    "--primary": l.color_button,
    "--on-primary": "#ffffff",
    "--focus": l.color_button,
  };
}
