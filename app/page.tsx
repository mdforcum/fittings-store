import Shop from "@/components/Shop";
import { getCatalog } from "@/lib/server";

// Stock and prices are read fresh on every visit.
export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ products, settings, ok }, params] = await Promise.all([getCatalog(), searchParams]);
  return <Shop products={products} settings={settings} ok={ok} openCart={params.cart === "open"} />;
}
