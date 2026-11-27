// A part's own page: one address per part, readable by search engines and
// easy to share. Stock and price are read fresh on every visit.
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CartLink, PartBuy } from "@/components/PartBuy";
import { Picture } from "@/components/ui";
import { conditionLabel, warrantyText } from "@/lib/browse";
import { money, photoUrl, stockInfo, typeOf } from "@/lib/catalog";
import { madeInUSA } from "@/lib/foundation";
import { jsonForScript, originOf, partDescription, partJsonLd, partPath, partTitle, replaces } from "@/lib/seo";
import { getShopCatalog } from "@/lib/server";
import { lookStyle } from "@/lib/storefront";
import { storeForRequest } from "@/lib/storefront-server";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : null);

async function load({ params, searchParams }: Props) {
  const id = decodeURIComponent((await params).id);
  const { look, storefront } = await storeForRequest(one((await searchParams).storefront));
  const ownDealer = storefront && storefront.stock_scope === "own" ? storefront.dealer_id : null;
  const catalog = await getShopCatalog(ownDealer, storefront?.dealer_id ?? null);
  const part = catalog.products.find((p) => p.id === id) ?? null;
  const h = await headers();
  const origin = originOf(h.get("x-forwarded-host") ?? h.get("host"), h.get("x-forwarded-proto"));
  const storeName = look?.name || catalog.settings.store_name;
  return { id, look, catalog, part, origin, storeName };
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const { part, catalog, origin, storeName, look } = await load(props);
  if (!part) return { title: `Part not found | ${storeName}`, robots: { index: false } };
  const description = partDescription(part, catalog.xrefs[part.id], storeName);
  const title = partTitle(part, storeName);
  const images = part.photos.slice(0, 4).map(photoUrl);
  return {
    title,
    description,
    ...(origin ? { metadataBase: new URL(origin) } : {}),
    alternates: { canonical: partPath(part.id) },
    // A staff preview of a store that isn't open yet stays out of search.
    ...(look?.preview ? { robots: { index: false, follow: false } } : {}),
    openGraph: { title, description, url: partPath(part.id), siteName: storeName, type: "website", ...(images.length ? { images } : {}) },
  };
}

export default async function PartPage(props: Props) {
  const { part, catalog, origin, storeName, look } = await load(props);
  if (!part) notFound();
  const { settings } = catalog;
  const suffix = look?.preview ? `?storefront=${look.slug}` : "";
  const home = `/${suffix}`;
  const xrefs = catalog.xrefs[part.id] ?? [];
  const rep = replaces(xrefs);
  const stock = stockInfo(part, settings.low_stock);
  const description = partDescription(part, xrefs, storeName);
  const jsonLd = partJsonLd(part, { url: `${origin}${partPath(part.id)}`, storeName, images: part.photos.slice(0, 4).map(photoUrl), xrefs, description });
  const email = look?.email || settings.email;
  const charges = catalog.charges[part.id] ?? [];
  const spot = catalog.spots[part.id];

  return (
    <div className={look ? "storefront" : undefined} style={look ? (lookStyle(look) as React.CSSProperties) : undefined}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonForScript(jsonLd) }} />
      <header className="top">
        <div className="wrap">
          <Link className={look?.logo_url ? "brand brand-logo" : "brand"} href={home}>
            {look?.logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element -- a dealer's own logo file, shown as is
              <img src={look.logo_url} alt={storeName} height={48} />
            ) : (
              storeName
            )}
          </Link>
          <nav aria-label="Store">
            <Link href={home}>All parts</Link>
            <CartLink href={`/${suffix ? `${suffix}&` : "?"}cart=open`} />
          </nav>
        </div>
      </header>
      <main className="wrap part-page">
        <p className="crumbs">
          <Link href={home}>All parts</Link> <span aria-hidden="true">›</span> {typeOf(part.type).label}
        </p>
        <div className="part-cols">
          <div className="gallery part-photos" tabIndex={0} aria-label="Photos">
            {part.photos.length > 0 ? (
              part.photos.map((path) => (
                <div key={path}>
                  <Picture product={part} path={path} alt={part.name} />
                </div>
              ))
            ) : (
              <div>
                <Picture product={part} />
              </div>
            )}
          </div>
          <div className="part-info">
            <h1>{part.name}</h1>
            <dl className="specs">
              {part.part_number && (
                <>
                  <dt>Part #</dt>
                  <dd>{part.part_number}</dd>
                </>
              )}
              {part.size && (
                <>
                  <dt>Size</dt>
                  <dd>{part.size}</dd>
                </>
              )}
              {part.dash && (
                <>
                  <dt>Dash size</dt>
                  <dd>{part.dash}</dd>
                </>
              )}
              {part.thread && (
                <>
                  <dt>Thread</dt>
                  <dd>{part.thread}</dd>
                </>
              )}
              {part.brand && (
                <>
                  <dt>Brand</dt>
                  <dd>{part.brand}</dd>
                </>
              )}
              {part.origin && (
                <>
                  <dt>Made in</dt>
                  <dd>{madeInUSA(part.origin) ? "USA" : part.origin}</dd>
                </>
              )}
              <dt>Condition</dt>
              <dd>
                {conditionLabel(part.condition)}
                {part.warranty_months ? ` · ${warrantyText(part.warranty_months)}` : ""}
              </dd>
              {rep.length > 0 && (
                <>
                  <dt>Replaces</dt>
                  <dd>{rep.join(", ")}</dd>
                </>
              )}
            </dl>
            {part.description && <p>{part.description}</p>}
            {spot && (
              <div className="find-it">
                <p>
                  <b>Find it in our shop:</b> {spot.line}
                </p>
                <p className="mono">Shelf code {spot.code}</p>
              </div>
            )}
            <div className="total">
              <span className={`pill ${stock.tone}`}>{stock.text}</span>
              {part.price_mode === "quote" ? <span className="hint">Priced by quote</span> : (part.price_cents ?? 0) > 0 ? <b>{money(part.price_cents)}</b> : <span className="hint">Price pending</span>}
            </div>
            {charges.map((c) => (
              <p className="hint" key={c.kind}>
                Plus a {money(c.amount_cents)} {c.label.toLowerCase() || "charge"}
                {c.kind === "core" ? (
                  <>
                    , refunded when your old part comes back. <Link href="/cores">How cores work</Link>
                  </>
                ) : c.refundable ? (
                  ", refundable."
                ) : (
                  "."
                )}
              </p>
            ))}
            {part.ship_class === "freight" || part.ship_class === "oversize" ? (
              <p className="hint">Ships by truck: the cart sends it for a freight quote to your ZIP code.</p>
            ) : part.ship_class === "pickup" ? (
              <p className="hint">Pickup at the counter only.</p>
            ) : null}
            {part.price_mode === "quote" ? (
              <Link className="btn" href={`/${suffix ? `${suffix}&` : "?"}item=${encodeURIComponent(part.id)}`}>
                Ask for a price
              </Link>
            ) : (
              <PartBuy id={part.id} name={part.name} qty={part.qty} priced={(part.price_cents ?? 0) > 0} cartHref={`/${suffix ? `${suffix}&` : "?"}cart=open`} />
            )}
            {email && (
              <p className="hint">
                Questions about this part? Email <a href={`mailto:${email}`}>{email}</a>.
              </p>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
