-- ---------------------------------------------------------------------------
-- Pick marks (2026-11-26): the check-offs on a pick ticket. One row per order
-- line and product pulled (a package with no shelf spot is pulled as its
-- parts, so one line may have several rows). picked_qty is how many are in
-- hand; the ticket counts a line done when it reaches what the line needs
-- (lib/picking.ts). Back office only: no shopper can read or write it.
-- Safe to run more than once.
-- ---------------------------------------------------------------------------
create table if not exists shop.fittings_pick_marks (
  order_item_id bigint not null references shop.fittings_order_items(id) on delete cascade,
  product_id text not null,
  picked_qty integer not null default 0 check (picked_qty >= 0),
  picked_at timestamptz not null default now(),
  primary key (order_item_id, product_id)
);
alter table shop.fittings_pick_marks enable row level security;
revoke all on shop.fittings_pick_marks from anon, authenticated;
grant all on shop.fittings_pick_marks to service_role;
