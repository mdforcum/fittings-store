// The dealer page as an app on a phone's home screen: its name, icons and
// colours. Only the dealer page links to this, so the shop itself is unchanged.
export const dynamic = "force-static";

export function GET() {
  const manifest = {
    id: "/dealer",
    name: "Backroad Iron Dealer",
    short_name: "Dealer",
    description: "Orders to pull and ship, stock counts and bin labels for Backroad Iron dealers.",
    start_url: "/dealer",
    scope: "/dealer",
    display: "standalone",
    orientation: "portrait",
    background_color: "#e8ecee",
    theme_color: "#2b404d",
    icons: [
      { src: "/icons/dealer-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/dealer-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/dealer-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
  return new Response(JSON.stringify(manifest), { headers: { "content-type": "application/manifest+json; charset=utf-8", "cache-control": "public, max-age=3600" } });
}
