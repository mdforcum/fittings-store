import type { Metadata } from "next";
import Capture from "@/components/Capture";
import Login from "@/components/Login";
import { isAdmin } from "@/lib/auth";
import { env } from "@/lib/server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Capture", robots: { index: false, follow: false } };

export default async function CapturePage() {
  if (!env.secret || !env.adminPassword) {
    return (
      <main className="center">
        <p className="eyebrow">Capture</p>
        <h1>Finish the back office first</h1>
        <p>
          Capture uses the same sign-in as the back office. Open <a href="/admin">the back office</a> and
          follow the steps there.
        </p>
      </main>
    );
  }
  if (!(await isAdmin())) return <Login />;
  return <Capture />;
}
