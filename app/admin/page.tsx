import type { Metadata } from "next";
import Admin from "@/components/Admin";
import Login from "@/components/Login";
import { isAdmin } from "@/lib/auth";
import { env } from "@/lib/server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Back office", robots: { index: false, follow: false } };

export default async function AdminPage() {
  const missing = [
    !env.secret && "SUPABASE_SECRET_KEY",
    !env.adminPassword && "ADMIN_PASSWORD",
  ].filter(Boolean) as string[];

  if (missing.length) {
    return (
      <main className="center">
        <p className="eyebrow">Back office</p>
        <h1>Two settings to finish</h1>
        <p>
          The back office switches on once these are added in Vercel under Project, Settings, Environment
          Variables, followed by a redeploy:
        </p>
        <ul className="mono">
          {missing.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
        <p className="hint">
          SUPABASE_SECRET_KEY is the secret key from Supabase, Project settings, API keys. ADMIN_PASSWORD
          is a long password you choose for this page.
        </p>
      </main>
    );
  }
  if (!(await isAdmin())) return <Login />;
  return <Admin />;
}
