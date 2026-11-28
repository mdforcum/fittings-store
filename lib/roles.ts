// Dealer roles and the rules that hang on them: the second check before an
// order ships, and counts that wait for a manager. Pure, so the page, the
// server and the tests agree. The database enforces the same rules
// (supabase/add-dealer-roles.sql); this file decides what to show and say.

export type Role = "manager" | "worker";
export type ShipCheckMode = "off" | "any" | "manager";

/** A dealer's own rules. `ready` is false until the database change has run. */
export type DealerRules = { ready: boolean; ship_check: ShipCheckMode; count_hold_over: number };
export const NO_RULES: DealerRules = { ready: false, ship_check: "off", count_hold_over: 0 };

/** Who packed an order at a location, and who checked it. */
export type ShipCheck = { packed_by: string | null; packed_name: string; packed_at: string; checked_name: string; checked_at: string | null; override_reason: string };

/** Before roles existed every login could do everything, so a missing role reads as manager. */
export function readRole(v: unknown): Role {
  return v === "worker" ? "worker" : "manager";
}

export function readRules(dealer: Record<string, unknown> | null | undefined, tablesReady: boolean): DealerRules {
  if (!dealer || !("ship_check" in dealer) || !tablesReady) return NO_RULES;
  const mode = dealer.ship_check === "any" || dealer.ship_check === "manager" ? dealer.ship_check : "off";
  const hold = typeof dealer.count_hold_over === "number" && dealer.count_hold_over >= 0 ? Math.floor(dealer.count_hold_over) : 0;
  return { ready: true, ship_check: mode, count_hold_over: hold };
}

export const MODE_LABEL: Record<ShipCheckMode, string> = {
  off: "No second check",
  any: "Any second person checks",
  manager: "A manager checks",
};

export type CheckStep =
  /** No second check: ship as usual. */
  | { state: "none" }
  /** Not packed yet. */
  | { state: "pack" }
  /** Packed, waiting for the check. `why` says why this person can't be the one, when they can't. */
  | { state: "wait"; canCheck: boolean; canOverride: boolean; why: string }
  /** Checked: it can ship. */
  | { state: "done" };

/** Where an order stands at a location, and what the person looking at it may do. */
export function checkStep(mode: ShipCheckMode, check: ShipCheck | null | undefined, me: { id: string; role: Role }): CheckStep {
  if (mode === "off") return { state: "none" };
  if (!check) return { state: "pack" };
  if (check.checked_at) return { state: "done" };
  const mine = check.packed_by === me.id;
  const needsManager = mode === "manager" && me.role !== "manager";
  const why = mine ? "You packed this, so someone else has to check it." : needsManager ? "A manager has to check this." : "";
  return { state: "wait", canCheck: !mine && !needsManager, canOverride: me.role === "manager", why };
}

/** An override reason has to say something. The database asks for the same. */
export const OVERRIDE_MIN = 5;

export type CountLine = { product_id: string; qty: number };
export type HeldCount = { product_id: string; from: number; to: number };

/**
 * Sorts a worker's counts into the ones saved now and the ones that wait for a
 * manager: a count waits when it moves the number by more than the dealer's
 * set amount. A manager's counts never wait.
 */
export function splitCounts(lines: CountLine[], now: (productId: string) => number, role: Role, rules: DealerRules): { apply: CountLine[]; hold: HeldCount[] } {
  if (role === "manager" || !rules.ready) return { apply: lines, hold: [] };
  const apply: CountLine[] = [];
  const hold: HeldCount[] = [];
  for (const l of lines) {
    const from = now(l.product_id);
    if (Math.abs(l.qty - from) > rules.count_hold_over) hold.push({ product_id: l.product_id, from, to: l.qty });
    else apply.push(l);
  }
  return { apply, hold };
}

/** The database's refusals, in plain words. */
export function checkProblem(message: string): string {
  if (/ship check needed/.test(message)) return "This order needs a second check before it ships.";
  if (/same person/.test(message)) return "You packed this, so someone else has to check it. A manager can override with a reason.";
  if (/manager needed/.test(message)) return "A manager has to do this.";
  if (/only a manager can override/.test(message)) return "Only a manager can override the second check.";
  if (/give a reason/.test(message)) return "Say why in a few words.";
  if (/not packed yet/.test(message)) return "Mark it packed first.";
  if (/already checked/.test(message)) return "This order was already checked.";
  if (/already decided/.test(message)) return "Someone already answered that one.";
  if (/not one of this dealer/.test(message)) return "That isn't one of your locations.";
  return "That didn't save. Try again.";
}

/** One line of the activity log, in plain words. */
export function eventText(e: { action: string; user_name: string; detail?: Record<string, unknown> | null; order_number?: number | null }): string {
  const who = e.user_name || "Someone";
  const d = e.detail ?? {};
  const order = e.order_number ? ` order #${e.order_number}` : " an order";
  const part = typeof d.name === "string" && d.name ? d.name : typeof d.product_id === "string" ? d.product_id : "a part";
  switch (e.action) {
    case "pulled":
      return `${who} pulled the parts for${order}`;
    case "packed":
      return `${who} packed${order}`;
    case "checked":
      return `${who} checked${order}${d.packed_by ? `, packed by ${String(d.packed_by)}` : ""}`;
    case "override":
      return `${who} overrode the second check on${order}: ${String(d.reason ?? "")}`;
    case "shipped":
      return `${who} shipped${order}${d.tracking ? ` (${String(d.carrier ?? "")} ${String(d.tracking)})`.replace("( ", "(") : ""}`;
    case "label":
      return `${who} bought a label for${order}`;
    case "count":
      return `${who} counted ${part}: ${String(d.from ?? "?")} to ${String(d.to ?? "?")}`;
    case "counts":
      return `${who} saved ${String(d.lines ?? "several")} counts`;
    case "count_held":
      return `${who} counted ${part}: ${String(d.from ?? "?")} to ${String(d.to ?? "?")}, waiting for a manager`;
    case "count_approved":
      return `${who} approved ${String(d.asked_by ?? "a worker")}'s count of ${part}: ${String(d.from ?? "?")} to ${String(d.to ?? "?")}`;
    case "count_declined":
      return `${who} turned down ${String(d.asked_by ?? "a worker")}'s count of ${part}: ${String(d.from ?? "?")} to ${String(d.to ?? "?")}`;
    case "sold":
      return `${who} sold ${String(d.qty ?? 1)} of ${part} at the counter`;
    case "rules":
      return `${who} changed the shop rules`;
    default:
      return `${who}: ${e.action}`;
  }
}
