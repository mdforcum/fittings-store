import type { Metadata } from "next";
import Link from "next/link";
import { CORE_FULL_DAYS, CORE_PARTIAL_DAYS } from "@/lib/checkout-rules";
import { getCatalog } from "@/lib/server";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "How core charges work",
  description: "Core charges on rebuilt and exchange parts: full credit within 30 days, 85% from day 31 to 60.",
};

export default async function CoresPage() {
  const { settings } = await getCatalog();
  const tel = settings.phone.replace(/[^\d+]/g, "");
  return (
    <>
      <header className="top">
        <div className="wrap">
          <Link className="brand" href="/">
            {settings.store_name}
          </Link>
        </div>
      </header>
      <main className="wrap policy">
        <p className="eyebrow">Cores and returns</p>
        <h1>How core charges work</h1>
        <p>
          Rebuilt and exchange parts, like starters, alternators, pumps, injectors and cylinders, carry a core charge. It is a
          deposit on your old part. It shows on its own line in the cart and at checkout, and it comes back to the card you
          paid with when the old part comes back to us.
        </p>
        <table>
          <thead>
            <tr>
              <th>Old part arrives</th>
              <th>You get back</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Within {CORE_FULL_DAYS} days of your order</td>
              <td>The full core charge</td>
            </tr>
            <tr>
              <td>
                Day {CORE_FULL_DAYS + 1} to day {CORE_PARTIAL_DAYS}
              </td>
              <td>85% of the core charge</td>
            </tr>
            <tr>
              <td>After day {CORE_PARTIAL_DAYS}</td>
              <td>No credit</td>
            </tr>
          </tbody>
        </table>
        <h2>What counts as a good core</h2>
        <p>
          The same part, complete and in one piece: not cracked, burned, or taken apart, and drained of oil and fuel. Put it in
          the box the new part came in. If a core arrives damaged or incomplete we&apos;ll call you before deciding the credit.
        </p>
        <h2>Sending it back</h2>
        <p>
          Write your order number on the box. Bring it to the counter, or ship it to us; return freight is yours to pay unless
          we agree otherwise. The days count from the day you ordered to the day the core reaches us, and the refund goes out
          the day we check it in.
        </p>
        {(settings.phone || settings.email) && (
          <p>
            Questions about a core?{" "}
            {settings.phone && <a href={`tel:${tel}`}>{settings.phone}</a>}
            {settings.phone && settings.email && " or "}
            {settings.email && <a href={`mailto:${settings.email}`}>{settings.email}</a>}
          </p>
        )}
        <p>
          <Link href="/">Back to the shop</Link>
        </p>
      </main>
    </>
  );
}
