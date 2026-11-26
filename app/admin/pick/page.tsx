import type { Metadata } from "next";
import Login from "@/components/Login";
import PickTicket from "@/components/PickTicket";
import { isAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Pick ticket", robots: { index: false, follow: false } };

export default async function PickPage({ searchParams }: { searchParams: Promise<{ orders?: string }> }) {
  if (!(await isAdmin())) return <Login />;
  const { orders = "" } = await searchParams;
  return <PickTicket orders={orders} />;
}
