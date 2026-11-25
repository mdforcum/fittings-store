import type { Metadata } from "next";
import HoseBuilder from "@/components/HoseBuilder";
import { getCatalog } from "@/lib/server";
import { visionReady } from "@/lib/vision";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Hydraulic hose builder",
  description: "Replace a hydraulic hose assembly: snap the old one, enter its tag or part number, or build it by hand.",
};

export default async function HosePage() {
  const { settings } = await getCatalog();
  return <HoseBuilder storeName={settings.store_name} phone={settings.phone} reading={visionReady()} />;
}
