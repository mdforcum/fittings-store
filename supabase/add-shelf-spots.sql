-- ---------------------------------------------------------------------------
-- Shelf spots (2026-11-26): where a part sits in the shop, as a chain of
-- levels the dealer names and codes (location, building, area, aisle,
-- section, bin, sub-bins; see lib/shelf.ts). The part page prints the chain
-- as one line plus a joined code, the way a big-box store prints aisle and
-- bay. A part points at the deepest spot it sits in (products.spot_id).
-- Safe to run more than once.
-- ---------------------------------------------------------------------------
create table if not exists shop.fittings_shelf_spots (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid references shop.fittings_shelf_spots(id) on delete restrict,
  level text not null check (char_length(level) between 1 and 24),
  code text not null check (code ~ '^[A-Z0-9]{1,6}$'),
  label text not null default '' check (char_length(label) <= 60),
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  -- One code per parent, so a joined code names one spot.
  constraint fittings_shelf_spots_code_key unique nulls not distinct (parent_id, code)
);
create index if not exists fittings_shelf_spots_parent_idx on shop.fittings_shelf_spots(parent_id);

alter table shop.fittings_products
  add column if not exists spot_id uuid references shop.fittings_shelf_spots(id) on delete set null;
create index if not exists fittings_products_spot_idx on shop.fittings_products(spot_id);

alter table shop.fittings_shelf_spots enable row level security;
drop policy if exists "fittings_shelf_spots is public" on shop.fittings_shelf_spots;
create policy "fittings_shelf_spots is public" on shop.fittings_shelf_spots
  for select to anon, authenticated using (true);
revoke all on shop.fittings_shelf_spots from anon, authenticated;
grant select on shop.fittings_shelf_spots to anon, authenticated;
grant all on shop.fittings_shelf_spots to service_role;
