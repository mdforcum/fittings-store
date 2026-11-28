import type { Metadata } from "next";
import BinLabelSheet from "@/components/BinLabelSheet";
import { loadBinLabels } from "@/lib/bin-labels-server";
import { currentDealer } from "@/lib/dealer-session";
import { adminDb } from "@/lib/server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Bin labels", robots: { index: false, follow: false } };

export default async function DealerLabelsPage() {
  const db = adminDb();
  const s = await currentDealer(db);
  if (!s) {
    return (
      <main className="center portal">
        <p>Sign in to the dealer page first, then open bin labels from there.</p>
        <a className="btn" href="/dealer">
          Go to the dealer page
        </a>
      </main>
    );
  }
  // Only this dealer's own locations: never another shop's shelves.
  const lo = await db.from("fittings_locations").select("id").eq("dealer_id", s.dealer.id).eq("kind", "store");
  const mine = ((lo.data ?? []) as Array<{ id: string }>).map((l) => l.id);
  const data = await loadBinLabels(db, mine);
  return <BinLabelSheet labels={data.labels} tops={data.tops} problem={data.problem} back={{ href: "/dealer#layout", text: "Back to the dealer page" }} />;
}
