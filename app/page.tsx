import Shop from "@/components/Shop";
import { getShopCatalog } from "@/lib/server";

// Stock and prices are read fresh on every visit.
export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [catalog, params] = await Promise.all([getShopCatalog(), searchParams]);
  return <Shop {...catalog} openCart={params.cart === "open"} />;
}
