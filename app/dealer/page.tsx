import type { Metadata } from "next";
import DealerPortal from "@/components/DealerPortal";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Dealer orders", robots: { index: false, follow: false } };

export default function DealerPage() {
  return <DealerPortal />;
}
