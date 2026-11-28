import type { Metadata } from "next";
import BinLabelSheet from "@/components/BinLabelSheet";
import Login from "@/components/Login";
import { isAdmin } from "@/lib/auth";
import { loadBinLabels } from "@/lib/bin-labels-server";
import { adminDb } from "@/lib/server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Bin labels", robots: { index: false, follow: false } };

export default async function AdminLabelsPage() {
  if (!(await isAdmin())) return <Login />;
  const data = await loadBinLabels(adminDb());
  return <BinLabelSheet labels={data.labels} tops={data.tops} problem={data.problem} back={{ href: "/admin#spots", text: "Back to the shelf map" }} />;
}
