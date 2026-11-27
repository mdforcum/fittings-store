import type { Metadata } from "next";
import Shop from "@/components/Shop";
import { getShelves, getShopCatalog } from "@/lib/server";
import { storeForRequest } from "@/lib/storefront-server";

// Stock and prices are read fresh on every visit.
export const dynamic = "force-dynamic";

type Params = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : null);

export async function generateMetadata({ searchParams }: { searchParams: Params }): Promise<Metadata> {
  const { look } = await storeForRequest(one((await searchParams).storefront));
  if (!look) return {};
  return {
    title: `${look.name} | Parts`,
    description: `${look.tagline || "Parts in stock"} from ${look.name}. Order online for shipping or counter pickup.`,
  };
}

export default async function Home({ searchParams }: { searchParams: Params }) {
  const params = await searchParams;
  const { look, storefront } = await storeForRequest(one(params.storefront));
  // A store showing only its own stock is limited to its dealer's shelves;
  // one showing the whole network sees everything, as the Backroad Iron store does.
  const ownDealer = storefront && storefront.stock_scope === "own" ? storefront.dealer_id : null;
  const poolDealer = storefront?.dealer_id ?? null;
  const catalog = await getShopCatalog(ownDealer, poolDealer);
  const filterOn = look ? look.location_filter : catalog.settings.location_filter;
  const shelves = filterOn ? await getShelves(ownDealer, poolDealer) : [];
  return <Shop {...catalog} look={look} shelfStock={shelves} openCart={params.cart === "open"} />;
}
