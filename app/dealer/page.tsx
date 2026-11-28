import type { Metadata, Viewport } from "next";
import DealerPortal from "@/components/DealerPortal";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Dealer orders",
  robots: { index: false, follow: false },
  // Lets the dealer page be put on a phone's home screen and open like an app.
  manifest: "/dealer/manifest.webmanifest",
  icons: { apple: "/icons/dealer-apple-180.png" },
  appleWebApp: { capable: true, title: "Dealer", statusBarStyle: "default" },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#2b404d" };

export default function DealerPage() {
  return <DealerPortal />;
}
