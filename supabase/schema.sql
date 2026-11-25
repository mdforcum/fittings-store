-- Fittings store schema.
-- Lives in the shared fieldline-staging database, so every object carries a
-- fittings_ prefix and nothing here touches other tables. Applied by hand
-- (not through that project's migration history) so it never collides with
-- the Backroad Iron migrations.

create table if not exists public.fittings_products (
  id text primary key,
  name text not null,
  type text not null default 'other',
  size text not null default '',
  dash text not null default '',
  thread text not null default '',
  part_number text not null default '',
  description text not null default '',
  price_cents integer check (price_cents is null or price_cents >= 0),
  qty integer not null default 0 check (qty >= 0),
  photos text[] not null default '{}',
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.fittings_product_costs (
  product_id text primary key references public.fittings_products(id) on delete cascade,
  cost_cents integer check (cost_cents is null or cost_cents >= 0),
  margin numeric(7,2)
);

create table if not exists public.fittings_settings (
  id integer primary key default 1 check (id = 1),
  store_name text not null default 'Hydraulic Fittings',
  tagline text not null default 'Caps and plugs for open hydraulic lines',
  phone text not null default '',
  email text not null default '',
  low_stock integer not null default 3,
  shipping_flat_cents integer not null default 800 check (shipping_flat_cents >= 0),
  order_min_cents integer not null default 1500 check (order_min_cents >= 0),
  free_ship_over_cents integer check (free_ship_over_cents is null or free_ship_over_cents >= 0)
);

-- Server-only values: ship-from address, parcel presets, tax mode, Stripe webhook secret.
create table if not exists public.fittings_private_config (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.fittings_orders (
  id uuid primary key default gen_random_uuid(),
  number bigint generated always as identity (start with 1001),
  status text not null default 'pending'
    check (status in ('pending','paid','shipped','cancelled','expired')),
  stripe_session_id text unique,
  stripe_payment_intent text,
  email text,
  customer_name text,
  phone text,
  ship_to jsonb,
  subtotal_cents integer not null default 0,
  shipping_cents integer not null default 0,
  tax_cents integer not null default 0,
  total_cents integer not null default 0,
  stock_short boolean not null default false,
  carrier text,
  service text,
  tracking_number text,
  tracking_url text,
  shippo_transaction_id text,
  label_cost_cents integer,
  notes text not null default '',
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  shipped_at timestamptz
);

create table if not exists public.fittings_order_items (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.fittings_orders(id) on delete cascade,
  product_id text not null,
  name text not null,
  part_number text not null default '',
  unit_price_cents integer not null,
  qty integer not null check (qty > 0)
);

create index if not exists fittings_order_items_order_idx on public.fittings_order_items(order_id);
create index if not exists fittings_orders_status_idx on public.fittings_orders(status, created_at desc);

-- Row level security: shoppers may read the catalog and public store settings.
-- Everything else is reachable only with the server's secret key.
alter table public.fittings_products enable row level security;
alter table public.fittings_product_costs enable row level security;
alter table public.fittings_settings enable row level security;
alter table public.fittings_private_config enable row level security;
alter table public.fittings_orders enable row level security;
alter table public.fittings_order_items enable row level security;

drop policy if exists "fittings catalog is public" on public.fittings_products;
create policy "fittings catalog is public" on public.fittings_products
  for select to anon, authenticated using (true);
drop policy if exists "fittings settings are public" on public.fittings_settings;
create policy "fittings settings are public" on public.fittings_settings
  for select to anon, authenticated using (true);

revoke all on public.fittings_products, public.fittings_product_costs, public.fittings_settings,
  public.fittings_private_config, public.fittings_orders, public.fittings_order_items
  from anon, authenticated;
grant select on public.fittings_products, public.fittings_settings to anon, authenticated;
grant all on public.fittings_products, public.fittings_product_costs, public.fittings_settings,
  public.fittings_private_config, public.fittings_orders, public.fittings_order_items
  to service_role;

-- Marks a pending order paid and takes its items out of stock, all or nothing.
-- Safe to call twice: the second call finds no pending order and returns false.
create or replace function public.fittings_fulfill_order(p_order_id uuid, p_details jsonb)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_short boolean := false;
  v_have integer;
  r record;
begin
  update fittings_orders set
    status = 'paid',
    paid_at = now(),
    stripe_session_id = coalesce(p_details->>'stripe_session_id', stripe_session_id),
    stripe_payment_intent = p_details->>'stripe_payment_intent',
    email = p_details->>'email',
    customer_name = p_details->>'customer_name',
    phone = p_details->>'phone',
    ship_to = p_details->'ship_to',
    subtotal_cents = coalesce((p_details->>'subtotal_cents')::integer, subtotal_cents),
    shipping_cents = coalesce((p_details->>'shipping_cents')::integer, shipping_cents),
    tax_cents = coalesce((p_details->>'tax_cents')::integer, 0),
    total_cents = coalesce((p_details->>'total_cents')::integer, total_cents)
  where id = p_order_id and status in ('pending', 'expired');
  if not found then
    return false;
  end if;

  for r in select product_id, qty from fittings_order_items where order_id = p_order_id loop
    select qty into v_have from fittings_products where id = r.product_id for update;
    if v_have is null or v_have < r.qty then
      v_short := true;
    end if;
    update fittings_products
      set qty = greatest(qty - r.qty, 0), updated_at = now()
      where id = r.product_id;
  end loop;

  if v_short then
    update fittings_orders set stock_short = true where id = p_order_id;
  end if;
  return true;
end;
$$;

-- Adds or subtracts stock without a read-then-write race against sales.
create or replace function public.fittings_adjust_qty(p_id text, p_delta integer)
returns integer
language sql
set search_path = public
as $$
  update fittings_products
    set qty = greatest(qty + p_delta, 0), updated_at = now()
    where id = p_id
  returning qty;
$$;

revoke all on function public.fittings_fulfill_order(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.fittings_adjust_qty(text, integer) from public, anon, authenticated;
grant execute on function public.fittings_fulfill_order(uuid, jsonb) to service_role;
grant execute on function public.fittings_adjust_qty(text, integer) to service_role;

-- Product photos: public to view, written only by the server.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fittings-photos', 'fittings-photos', true, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

insert into public.fittings_settings (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Inventory survey: photographing inventory cards and parts bins at a location.
--
-- Captures are the only facts stored. Which captures belong to the same part
-- is worked out fresh from the whole pile every time it is read (lib/match.ts),
-- so the order photos were taken in can never change the answer.
-- ---------------------------------------------------------------------------

create table if not exists public.fittings_locations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.fittings_captures (
  -- Made on the phone, so an upload that is retried never creates a second row.
  id uuid primary key,
  location_id uuid not null references public.fittings_locations(id) on delete cascade,
  kind text not null check (kind in ('card','bin','code','manual')),
  captured_at timestamptz not null,
  created_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending','read','failed')),
  read_error text not null default '',
  photo text,
  part_number text not null default '',
  upc text not null default '',
  description text not null default '',
  part_type text not null default '',
  aisle text not null default '',
  bin text not null default '',
  qty_on_card integer check (qty_on_card is null or qty_on_card >= 0),
  count_seen integer check (count_seen is null or count_seen >= 0),
  count_confidence text check (count_confidence is null or count_confidence in ('high','medium','low')),
  count_note text not null default '',
  codes text[] not null default '{}',
  notes text not null default '',
  use_location boolean not null default true,
  confirmed boolean not null default false,
  edited boolean not null default false
);

create index if not exists fittings_captures_location_idx
  on public.fittings_captures(location_id, captured_at desc);

-- ---------------------------------------------------------------------------
-- Supplier photos: product photos read from a distributor's own catalog pages.
-- They stay on hold, out of the shop, until permission is recorded in Settings.
-- ---------------------------------------------------------------------------

create table if not exists public.fittings_supplier_index (
  source text not null,
  part_norm text not null,
  part_number text not null,
  name text not null default '',
  page_url text not null,
  image_url text not null,
  seen_at timestamptz not null default now(),
  primary key (source, part_norm)
);

create table if not exists public.fittings_supplier_photos (
  id uuid primary key default gen_random_uuid(),
  product_id text not null references public.fittings_products(id) on delete cascade,
  source text not null,
  page_url text not null default '',
  image_url text not null,
  held_path text not null,
  public_path text,
  imported_at timestamptz not null default now(),
  unique (product_id, image_url)
);

alter table public.fittings_locations enable row level security;
alter table public.fittings_captures enable row level security;
alter table public.fittings_supplier_index enable row level security;
alter table public.fittings_supplier_photos enable row level security;

revoke all on public.fittings_locations, public.fittings_captures,
  public.fittings_supplier_index, public.fittings_supplier_photos
  from anon, authenticated;
grant all on public.fittings_locations, public.fittings_captures,
  public.fittings_supplier_index, public.fittings_supplier_photos
  to service_role;

-- Survey photos and supplier photos on hold: never public, read only through the server.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fittings-private', 'fittings-private', false, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;
