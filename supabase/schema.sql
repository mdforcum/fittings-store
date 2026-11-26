-- Fittings store schema.
-- Lives in the shared fieldline-staging database, in its own schema `shop`, so
-- Backroad Iron's migrations own `public` and `fieldline` alone: its deploy
-- check compares those two schemas against its migration files, and anything
-- of ours there would fail it. Applied by hand (not through that project's
-- migration history). The shop reads Backroad Iron's shared catalog
-- (public.catalog_*) but never writes it; shared machine data goes in through
-- Backroad Iron's own migrations and loaders.
-- The Data API must list `shop` under exposed schemas (dashboard: Project
-- Settings > Data API), or the shop's client cannot reach these tables.

create schema if not exists shop;
grant usage on schema shop to anon, authenticated, service_role;

create table if not exists shop.fittings_products (
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

create table if not exists shop.fittings_product_costs (
  product_id text primary key references shop.fittings_products(id) on delete cascade,
  cost_cents integer check (cost_cents is null or cost_cents >= 0),
  margin numeric(7,2)
);

create table if not exists shop.fittings_settings (
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
create table if not exists shop.fittings_private_config (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists shop.fittings_orders (
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

create table if not exists shop.fittings_order_items (
  id bigint generated always as identity primary key,
  order_id uuid not null references shop.fittings_orders(id) on delete cascade,
  product_id text not null,
  name text not null,
  part_number text not null default '',
  unit_price_cents integer not null,
  qty integer not null check (qty > 0)
);

create index if not exists fittings_order_items_order_idx on shop.fittings_order_items(order_id);
create index if not exists fittings_orders_status_idx on shop.fittings_orders(status, created_at desc);

-- Row level security: shoppers may read the catalog and public store settings.
-- Everything else is reachable only with the server's secret key.
alter table shop.fittings_products enable row level security;
alter table shop.fittings_product_costs enable row level security;
alter table shop.fittings_settings enable row level security;
alter table shop.fittings_private_config enable row level security;
alter table shop.fittings_orders enable row level security;
alter table shop.fittings_order_items enable row level security;

drop policy if exists "fittings catalog is public" on shop.fittings_products;
create policy "fittings catalog is public" on shop.fittings_products
  for select to anon, authenticated using (true);
drop policy if exists "fittings settings are public" on shop.fittings_settings;
create policy "fittings settings are public" on shop.fittings_settings
  for select to anon, authenticated using (true);

revoke all on shop.fittings_products, shop.fittings_product_costs, shop.fittings_settings,
  shop.fittings_private_config, shop.fittings_orders, shop.fittings_order_items
  from anon, authenticated;
grant select on shop.fittings_products, shop.fittings_settings to anon, authenticated;
grant all on shop.fittings_products, shop.fittings_product_costs, shop.fittings_settings,
  shop.fittings_private_config, shop.fittings_orders, shop.fittings_order_items
  to service_role;

-- Marks a pending order paid and takes its items out of stock, all or nothing.
-- Safe to call twice: the second call finds no pending order and returns false.
create or replace function shop.fittings_fulfill_order(p_order_id uuid, p_details jsonb)
returns boolean
language plpgsql
set search_path = shop, public, extensions
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
create or replace function shop.fittings_adjust_qty(p_id text, p_delta integer)
returns integer
language sql
set search_path = shop, public, extensions
as $$
  update fittings_products
    set qty = greatest(qty + p_delta, 0), updated_at = now()
    where id = p_id
  returning qty;
$$;

revoke all on function shop.fittings_fulfill_order(uuid, jsonb) from public, anon, authenticated;
revoke all on function shop.fittings_adjust_qty(text, integer) from public, anon, authenticated;
grant execute on function shop.fittings_fulfill_order(uuid, jsonb) to service_role;
grant execute on function shop.fittings_adjust_qty(text, integer) to service_role;

-- Product photos: public to view, written only by the server.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fittings-photos', 'fittings-photos', true, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

insert into shop.fittings_settings (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Inventory survey: photographing inventory cards and parts bins at a location.
--
-- Captures are the only facts stored. Which captures belong to the same part
-- is worked out fresh from the whole pile every time it is read (lib/match.ts),
-- so the order photos were taken in can never change the answer.
-- ---------------------------------------------------------------------------

create table if not exists shop.fittings_locations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists shop.fittings_captures (
  -- Made on the phone, so an upload that is retried never creates a second row.
  id uuid primary key,
  location_id uuid not null references shop.fittings_locations(id) on delete cascade,
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
  on shop.fittings_captures(location_id, captured_at desc);

-- ---------------------------------------------------------------------------
-- Supplier photos: product photos read from a distributor's own catalog pages.
-- They stay on hold, out of the shop, until permission is recorded in Settings.
-- ---------------------------------------------------------------------------

create table if not exists shop.fittings_supplier_index (
  source text not null,
  part_norm text not null,
  part_number text not null,
  name text not null default '',
  page_url text not null,
  image_url text not null,
  seen_at timestamptz not null default now(),
  primary key (source, part_norm)
);

create table if not exists shop.fittings_supplier_photos (
  id uuid primary key default gen_random_uuid(),
  product_id text not null references shop.fittings_products(id) on delete cascade,
  source text not null,
  page_url text not null default '',
  image_url text not null,
  held_path text not null,
  public_path text,
  imported_at timestamptz not null default now(),
  unique (product_id, image_url)
);

alter table shop.fittings_locations enable row level security;
alter table shop.fittings_captures enable row level security;
alter table shop.fittings_supplier_index enable row level security;
alter table shop.fittings_supplier_photos enable row level security;

revoke all on shop.fittings_locations, shop.fittings_captures,
  shop.fittings_supplier_index, shop.fittings_supplier_photos
  from anon, authenticated;
grant all on shop.fittings_locations, shop.fittings_captures,
  shop.fittings_supplier_index, shop.fittings_supplier_photos
  to service_role;

-- Survey photos and supplier photos on hold: never public, read only through the server.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fittings-private', 'fittings-private', false, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Catalog foundation: the ten structures every category is built on.
-- See "Parts Store: Category Structure". Shoppers see no change from this
-- section on its own; the storefront starts reading it category by category.
--
--   1 category tree        fittings_categories
--   2 spec templates       fittings_categories.spec_fields + fittings_products.specs
--   3 variants             fittings_products.family + variant_label
--   4 cross-references     fittings_xrefs (the listed part # stays on the product)
--   5 machines, fitment    fittings_machines, fittings_fitment
--   6 kits                 fittings_kit_items
--   7 stock by location    fittings_products.qty (our shelf) + fittings_stock
--   8 shipping profile     fittings_products.ship_class, weight, size, freight class
--   9 surcharges           fittings_surcharges
--  10 documents            fittings_documents
-- ---------------------------------------------------------------------------

create table if not exists shop.fittings_categories (
  id text primary key,
  parent_id text references shop.fittings_categories(id) on delete restrict,
  name text not null,
  sort integer not null default 0,
  -- [{key, label, type: text|number|choice|multi|bool, filter: chips|list|range|toggle|search|none,
  --   unit?, choices?, column? (stored in a product column instead of specs), note?}]
  -- A category inherits its parents' fields; its own fields with the same key win.
  spec_fields jsonb not null default '[]'::jsonb check (jsonb_typeof(spec_fields) = 'array'),
  fitment text check (fitment is null or fitment in ('part_number','spec','size','none')),
  default_ship text check (default_ship is null or default_ship in ('parcel','freight','oversize','restricted','pickup')),
  live boolean not null default false,
  note text not null default '',
  check (parent_id is null or parent_id <> id)
);

alter table shop.fittings_products
  add column if not exists category_id text references shop.fittings_categories(id) on delete set null,
  add column if not exists brand text not null default '',
  add column if not exists family text not null default '',
  add column if not exists variant_label text not null default '',
  add column if not exists specs jsonb not null default '{}'::jsonb,
  add column if not exists kind text not null default 'part',
  add column if not exists ship_class text not null default 'parcel',
  add column if not exists weight_oz numeric(10,2),
  add column if not exists length_in numeric(7,2),
  add column if not exists width_in numeric(7,2),
  add column if not exists height_in numeric(7,2),
  add column if not exists freight_class text not null default '';

do $$ begin
  alter table shop.fittings_products add constraint fittings_products_kind_chk
    check (kind in ('part','kit','service'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table shop.fittings_products add constraint fittings_products_ship_chk
    check (ship_class in ('parcel','freight','oversize','restricted','pickup'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table shop.fittings_products add constraint fittings_products_specs_chk
    check (jsonb_typeof(specs) = 'object');
exception when duplicate_object then null; end $$;
do $$ begin
  alter table shop.fittings_products add constraint fittings_products_dims_chk
    check ((weight_oz is null or weight_oz > 0) and (length_in is null or length_in > 0)
       and (width_in is null or width_in > 0) and (height_in is null or height_in > 0));
exception when duplicate_object then null; end $$;

create index if not exists fittings_products_category_idx on shop.fittings_products(category_id);
create index if not exists fittings_products_family_idx on shop.fittings_products(family) where family <> '';

create table if not exists shop.fittings_xrefs (
  product_id text not null references shop.fittings_products(id) on delete cascade,
  kind text not null check (kind in ('oem','aftermarket','supplier','superseded','upc')),
  brand text not null default '',
  number text not null,
  -- Upper case, letters and digits only: "rE-50483" and "RE50483" are the same number.
  number_norm text not null check (number_norm ~ '^[A-Z0-9]+$'),
  primary key (product_id, kind, brand, number_norm)
);
create index if not exists fittings_xrefs_number_idx on shop.fittings_xrefs(number_norm);

create table if not exists shop.fittings_machines (
  id uuid primary key default gen_random_uuid(),
  make text not null,
  model text not null,
  series text not null default '',
  kind text not null default 'tractor',
  year_from integer check (year_from is null or year_from between 1900 and 2100),
  year_to integer check (year_to is null or year_to between 1900 and 2100),
  -- Spec-fit needs: [{compartment, spec, capacity_qt}] for fluids, [{axle, size}] for tires.
  requirements jsonb not null default '[]'::jsonb check (jsonb_typeof(requirements) = 'array'),
  notes text not null default '',
  unique (make, model)
);

create table if not exists shop.fittings_fitment (
  id uuid primary key default gen_random_uuid(),
  product_id text not null references shop.fittings_products(id) on delete cascade,
  machine_id uuid not null references shop.fittings_machines(id) on delete cascade,
  position text not null default '',
  serial_from text not null default '',
  serial_to text not null default '',
  engine text not null default '',
  qty_used integer not null default 1 check (qty_used > 0),
  strength text not null default 'confirmed' check (strength in ('confirmed','spec')),
  note text not null default '',
  unique (product_id, machine_id, position, serial_from)
);
create index if not exists fittings_fitment_machine_idx on shop.fittings_fitment(machine_id);

create table if not exists shop.fittings_kit_items (
  kit_id text not null references shop.fittings_products(id) on delete cascade,
  product_id text not null references shop.fittings_products(id) on delete restrict,
  qty integer not null check (qty > 0),
  sort integer not null default 0,
  primary key (kit_id, product_id),
  check (kit_id <> product_id)
);

-- Places other than our own shelf: a dealer's shelf (counted on a survey) or a supplier.
alter table shop.fittings_locations
  add column if not exists kind text not null default 'survey',
  add column if not exists lead_days integer,
  add column if not exists phone text not null default '';
do $$ begin
  alter table shop.fittings_locations add constraint fittings_locations_kind_chk
    check (kind in ('survey','dealer','supplier'));
exception when duplicate_object then null; end $$;

create table if not exists shop.fittings_stock (
  product_id text not null references shop.fittings_products(id) on delete cascade,
  location_id uuid not null references shop.fittings_locations(id) on delete cascade,
  qty integer not null check (qty >= 0),
  counted_at timestamptz not null default now(),
  lead_days integer check (lead_days is null or lead_days >= 0),
  primary key (product_id, location_id)
);

create table if not exists shop.fittings_surcharges (
  product_id text not null references shop.fittings_products(id) on delete cascade,
  kind text not null check (kind in ('core','tire_fee','hazmat','deposit')),
  amount_cents integer not null check (amount_cents >= 0),
  refundable boolean not null default false,
  label text not null default '',
  primary key (product_id, kind)
);

create table if not exists shop.fittings_documents (
  id uuid primary key default gen_random_uuid(),
  product_id text references shop.fittings_products(id) on delete cascade,
  machine_id uuid references shop.fittings_machines(id) on delete cascade,
  kind text not null check (kind in ('spec','sds','install','manual','parts_catalog','other')),
  title text not null,
  url text not null check (url ~ '^https?://'),
  sort integer not null default 0,
  check (num_nonnulls(product_id, machine_id) = 1)
);
create index if not exists fittings_documents_product_idx on shop.fittings_documents(product_id);

alter table shop.fittings_categories enable row level security;
alter table shop.fittings_xrefs enable row level security;
alter table shop.fittings_machines enable row level security;
alter table shop.fittings_fitment enable row level security;
alter table shop.fittings_kit_items enable row level security;
alter table shop.fittings_stock enable row level security;
alter table shop.fittings_surcharges enable row level security;
alter table shop.fittings_documents enable row level security;

-- Shopper-facing structures are public to read. Stock at other places is not:
-- a dealer's shelf counts stay private until that dealer agrees to show them.
do $$
declare t text;
begin
  foreach t in array array['fittings_categories','fittings_xrefs','fittings_machines','fittings_fitment',
                           'fittings_kit_items','fittings_surcharges','fittings_documents'] loop
    execute format('drop policy if exists "%s is public" on shop.%I', t, t);
    execute format('create policy "%s is public" on shop.%I for select to anon, authenticated using (true)', t, t);
  end loop;
end $$;

revoke all on shop.fittings_categories, shop.fittings_xrefs, shop.fittings_machines,
  shop.fittings_fitment, shop.fittings_kit_items, shop.fittings_stock,
  shop.fittings_surcharges, shop.fittings_documents from anon, authenticated;
grant select on shop.fittings_categories, shop.fittings_xrefs, shop.fittings_machines,
  shop.fittings_fitment, shop.fittings_kit_items, shop.fittings_surcharges,
  shop.fittings_documents to anon, authenticated;
grant all on shop.fittings_categories, shop.fittings_xrefs, shop.fittings_machines,
  shop.fittings_fitment, shop.fittings_kit_items, shop.fittings_stock,
  shop.fittings_surcharges, shop.fittings_documents to service_role;

-- Saves an item's catalog details in one go: product columns, then each list
-- replaced whole. Anything missing from p_details is left as it was.
create or replace function shop.fittings_save_details(p_id text, p_details jsonb)
returns void
language plpgsql
set search_path = shop, public, extensions
as $$
declare
  d jsonb := p_details;
begin
  if not exists (select 1 from fittings_products where id = p_id) then
    raise exception 'no such item %', p_id;
  end if;

  update fittings_products set
    category_id   = case when d ? 'category_id' then nullif(d->>'category_id', '') else category_id end,
    brand         = coalesce(d->>'brand', brand),
    origin        = coalesce(d->>'origin', origin),
    family        = coalesce(d->>'family', family),
    variant_label = coalesce(d->>'variant_label', variant_label),
    specs         = coalesce(d->'specs', specs),
    kind          = coalesce(d->>'kind', kind),
    ship_class    = coalesce(d->>'ship_class', ship_class),
    weight_oz     = case when d ? 'weight_oz' then (d->>'weight_oz')::numeric else weight_oz end,
    length_in     = case when d ? 'length_in' then (d->>'length_in')::numeric else length_in end,
    width_in      = case when d ? 'width_in' then (d->>'width_in')::numeric else width_in end,
    height_in     = case when d ? 'height_in' then (d->>'height_in')::numeric else height_in end,
    freight_class = coalesce(d->>'freight_class', freight_class),
    condition     = coalesce(d->>'condition', condition),
    universal     = coalesce((d->>'universal')::boolean, universal),
    warranty_months = case when d ? 'warranty_months' then (d->>'warranty_months')::integer else warranty_months end,
    price_mode    = coalesce(d->>'price_mode', price_mode),
    updated_at    = now()
  where id = p_id;

  if d ? 'xrefs' then
    delete from fittings_xrefs where product_id = p_id;
    insert into fittings_xrefs (product_id, kind, brand, number, number_norm)
      select distinct on (x->>'kind', coalesce(x->>'brand',''), x->>'number_norm')
        p_id, x->>'kind', coalesce(x->>'brand', ''), x->>'number', x->>'number_norm'
      from jsonb_array_elements(d->'xrefs') x;
  end if;

  if d ? 'surcharges' then
    delete from fittings_surcharges where product_id = p_id;
    insert into fittings_surcharges (product_id, kind, amount_cents, refundable, label)
      select distinct on (s->>'kind')
        p_id, s->>'kind', (s->>'amount_cents')::integer, coalesce((s->>'refundable')::boolean, false),
        coalesce(s->>'label', '')
      from jsonb_array_elements(d->'surcharges') s;
  end if;

  if d ? 'documents' then
    delete from fittings_documents where product_id = p_id;
    insert into fittings_documents (product_id, kind, title, url, sort)
      select p_id, x->>'kind', x->>'title', x->>'url', (ord * 10)::integer
      from jsonb_array_elements(d->'documents') with ordinality as t(x, ord);
  end if;

  if d ? 'kit_items' then
    delete from fittings_kit_items where kit_id = p_id;
    insert into fittings_kit_items (kit_id, product_id, qty, sort)
      select distinct on (x->>'product_id') p_id, x->>'product_id', (x->>'qty')::integer, (ord * 10)::integer
      from jsonb_array_elements(d->'kit_items') with ordinality as t(x, ord);
  end if;

  if d ? 'fitment' then
    delete from fittings_fitment where product_id = p_id;
    insert into fittings_fitment (product_id, machine_id, position, serial_prefix, serial_from, serial_to, engine, qty_used, strength, note)
      select distinct on (x->>'machine_id', coalesce(x->>'position', ''), coalesce(x->>'serial_prefix', ''), coalesce(x->>'serial_from', ''))
        p_id, (x->>'machine_id')::uuid, coalesce(x->>'position', ''), coalesce(x->>'serial_prefix', ''),
        coalesce(x->>'serial_from', ''), coalesce(x->>'serial_to', ''), coalesce(x->>'engine', ''),
        coalesce((x->>'qty_used')::integer, 1), coalesce(x->>'strength', 'confirmed'), coalesce(x->>'note', '')
      from jsonb_array_elements(d->'fitment') x;
  end if;

  if d ? 'stock' then
    delete from fittings_stock where product_id = p_id;
    insert into fittings_stock (product_id, location_id, qty, counted_at, lead_days)
      select distinct on (x->>'location_id') p_id, (x->>'location_id')::uuid, (x->>'qty')::integer,
        coalesce((x->>'counted_at')::timestamptz, now()), (x->>'lead_days')::integer
      from jsonb_array_elements(d->'stock') x;
  end if;
end;
$$;

revoke all on function shop.fittings_save_details(text, jsonb) from public, anon, authenticated;
grant execute on function shop.fittings_save_details(text, jsonb) to service_role;

-- The category tree for the launch categories. Re-running updates names,
-- order and spec templates, but never switches a category on or off.
insert into shop.fittings_categories (id, parent_id, name, sort, spec_fields, fitment, default_ship, live, note)
values
  -- Six departments. Every part sits in one place; the machine it fits, its
  -- condition and its brand are filters, never extra branches.
  ('machine-systems', null, 'Machine systems', 10, '[]'::jsonb, 'part_number', 'parcel', false, 'Parts every tractor and machine has: engine to cab. Filtered by machine.'),
  ('implements', null, 'Implements', 20, '[]'::jsonb, 'part_number', 'parcel', false, ''),
  ('construction', null, 'Construction equipment', 30, '[]'::jsonb, 'part_number', 'freight', false, 'Components only equipment has. Big components are usually sold by quote.'),
  ('hydraulics', null, 'Hydraulics', 40, '[]'::jsonb, 'size', 'parcel', true, ''),
  ('universal', null, 'Universal parts and shop', 50, '[]'::jsonb, 'spec', 'parcel', false, 'Fits by spec rather than by model.'),
  ('tires', null, 'Tires and wheels', 60, '[]'::jsonb, null, 'freight', false, 'Tires are sold and mounted through a partner tire service.'),
  ('tire-types', 'tires', 'Tires', 10, '[{"key": "tire_size", "label": "Size", "type": "text", "filter": "search"}, {"key": "rim_in", "label": "Rim diameter", "type": "number", "filter": "list", "unit": "in"}, {"key": "construction", "label": "Construction", "type": "choice", "filter": "chips", "choices": ["Radial", "Bias", "IF", "VF"]}, {"key": "tread", "label": "Tread type", "type": "choice", "filter": "chips", "choices": ["R-1", "R-1W", "R-2", "R-3", "R-4", "F-1", "F-2", "F-3", "I-1", "I-3"]}, {"key": "load", "label": "Load index, speed or ply", "type": "text", "filter": "list"}, {"key": "tube", "label": "Tube", "type": "choice", "filter": "chips", "choices": ["Tubeless (TL)", "Tube type (TT)"]}, {"key": "rci", "label": "Rolling circumference index", "type": "number", "filter": "none"}]'::jsonb, 'size', 'freight', false, 'Sold and mounted through a partner tire service.'),
  ('ms-engine', 'machine-systems', 'Engine', 10, '[]'::jsonb, null, null, false, ''),
  ('ms-cooling', 'machine-systems', 'Cooling', 20, '[]'::jsonb, null, null, false, ''),
  ('ms-fuel-exhaust', 'machine-systems', 'Fuel, air intake and exhaust', 30, '[]'::jsonb, null, null, false, ''),
  ('ms-electrical', 'machine-systems', 'Electrical and starting', 40, '[]'::jsonb, null, null, false, ''),
  ('ms-clutch-pto', 'machine-systems', 'Clutch and PTO', 60, '[]'::jsonb, null, null, false, ''),
  ('ms-transmission', 'machine-systems', 'Transmission, axles and differentials', 70, '[]'::jsonb, null, null, false, ''),
  ('ms-steering', 'machine-systems', 'Front axle and steering', 80, '[]'::jsonb, null, null, false, ''),
  ('ms-brakes-hitch', 'machine-systems', 'Brakes, hitch and 3-point', 90, '[]'::jsonb, null, null, false, ''),
  ('ms-cab', 'machine-systems', 'Cab, A/C and controls', 100, '[]'::jsonb, null, null, false, ''),
  ('ms-sheet-metal', 'machine-systems', 'Sheet metal, decals and paint', 110, '[]'::jsonb, null, 'freight', false, ''),
  ('impl-combine', 'implements', 'Combine and header', 10, '[]'::jsonb, null, null, false, ''),
  ('impl-hay', 'implements', 'Hay and forage', 20, '[]'::jsonb, null, null, false, ''),
  ('impl-planter', 'implements', 'Planter and drill', 30, '[]'::jsonb, null, null, false, ''),
  ('impl-tillage', 'implements', 'Tillage', 40, '[]'::jsonb, null, null, false, ''),
  ('impl-sprayer', 'implements', 'Sprayer', 50, '[]'::jsonb, null, null, false, ''),
  ('ce-undercarriage', 'construction', 'Undercarriage', 10, '[]'::jsonb, null, null, false, 'Track chains, shoes, rollers, idlers, sprockets.'),
  ('ce-final-drives', 'construction', 'Final drives and travel motors', 20, '[]'::jsonb, null, null, false, ''),
  ('ce-swing', 'construction', 'Swing motors and slewing rings', 30, '[]'::jsonb, null, null, false, ''),
  ('ce-attachments', 'construction', 'Buckets, couplers and thumbs', 40, '[]'::jsonb, null, null, false, ''),
  ('ce-ground-engaging', 'construction', 'Teeth and cutting edges', 50, '[]'::jsonb, null, null, false, ''),
  ('hyd-hose', 'hydraulics', 'Hose and hose builds', 20, '[]'::jsonb, null, null, false, ''),
  ('hyd-couplers', 'hydraulics', 'Quick couplers', 30, '[]'::jsonb, null, null, false, ''),
  ('hyd-cylinders', 'hydraulics', 'Cylinders', 40, '[]'::jsonb, 'part_number', null, false, 'Complete cylinders, new and rebuilt. Seal kits have their own shelf.'),
  ('hyd-seal-kits', 'hydraulics', 'Seal kits', 35, '[]'::jsonb, 'part_number', 'parcel', false, 'A core line: kits by machine, cylinder and serial break, and whole-machine packages.'),
  ('seal-kits-cylinder', 'hyd-seal-kits', 'Cylinder seal kits', 10, '[{"key": "cylinder", "label": "Cylinder", "type": "choice", "filter": "chips", "choices": ["Boom", "Dipper", "Stick", "Bucket", "Stabilizer", "Swing", "Loader lift", "Loader bucket (tilt)", "Extendahoe", "Loader clam (4-in-1)", "Blade lift", "Blade tilt", "Blade angle", "Ripper lift", "Ripper tip", "Thumb", "Blade", "Boom swing (offset)", "Lift", "Bucket (tilt)", "Steering", "Power steering", "Remote (rear)", "Grapple", "Other"]}, {"key": "rod_in", "label": "Rod diameter", "type": "number", "filter": "range", "unit": "in"}, {"key": "bore_in", "label": "Bore", "type": "number", "filter": "range", "unit": "in"}, {"key": "cylinder_pn", "label": "Cylinder part number", "type": "text", "filter": "search", "note": "The number stamped on the cylinder barrel"}, {"key": "piston", "label": "Piston", "type": "choice", "filter": "chips", "choices": ["One-piece", "Split"]}, {"key": "seal_material", "label": "Seal material", "type": "choice", "filter": "chips", "choices": ["Polyurethane", "Nitrile", "PTFE", "Viton", "Mixed"]}, {"key": "contents", "label": "What''s in the kit", "type": "text", "filter": "none", "note": "Rod seal, wiper, piston seal, wear rings, O-rings and backups"}]'::jsonb, null, null, false, 'One kit per cylinder. Fitment rows name the cylinder in Position.'),
  ('seal-kits-package', 'hyd-seal-kits', 'Machine seal kit packages', 20, '[{"key": "covers", "label": "Cylinders covered", "type": "number", "filter": "none"}, {"key": "contents", "label": "What''s in the package", "type": "text", "filter": "none"}]'::jsonb, null, null, false, 'Sold as kits: list the cylinder kits it holds.'),
  ('seal-kits-component', 'hyd-seal-kits', 'Pump, valve and swivel seal kits', 30, '[{"key": "component", "label": "Component", "type": "choice", "filter": "chips", "choices": ["Pump", "Control valve", "Swivel joint", "Swing motor", "Travel motor", "Steering unit", "Other"]}, {"key": "component_pn", "label": "Component part number", "type": "text", "filter": "search"}, {"key": "contents", "label": "What''s in the kit", "type": "text", "filter": "none"}]'::jsonb, null, null, false, ''),
  ('hyd-pumps-valves', 'hydraulics', 'Pumps, valves and motors', 50, '[]'::jsonb, 'part_number', null, false, ''),
  ('uni-bearings', 'universal', 'Bearings and seals', 10, '[]'::jsonb, null, null, false, ''),
  ('uni-chain', 'universal', 'Chain and sprockets', 30, '[]'::jsonb, null, null, false, ''),
  ('uni-lighting', 'universal', 'Lights', 40, '[]'::jsonb, null, null, false, ''),
  ('uni-seats', 'universal', 'Seats', 50, '[]'::jsonb, null, 'freight', false, ''),
  ('uni-pto', 'universal', 'PTO shafts and parts', 60, '[]'::jsonb, null, null, false, ''),
  ('uni-hardware', 'universal', 'Hardware, pins and fasteners', 70, '[]'::jsonb, null, null, false, ''),
  ('hydraulic-fittings', 'hydraulics', 'Fittings and adapters', 10, '[{"key": "size", "label": "Nominal size", "type": "text", "filter": "list", "column": "size"}, {"key": "dash", "label": "Dash size", "type": "text", "filter": "list", "column": "dash"}, {"key": "thread", "label": "Thread", "type": "text", "filter": "list", "column": "thread"}]'::jsonb, null, null, true, ''),
  ('orb-plugs', 'hydraulic-fittings', 'O-ring boss plugs', 10, '[]'::jsonb, null, null, true, ''),
  ('jic-caps', 'hydraulic-fittings', '37° JIC caps', 20, '[]'::jsonb, null, null, true, ''),
  ('jic-plugs', 'hydraulic-fittings', '37° JIC plugs', 30, '[]'::jsonb, null, null, true, ''),
  ('breather-plugs', 'hydraulic-fittings', 'Breather plugs', 40, '[]'::jsonb, null, null, true, ''),
  ('adapters', 'hydraulic-fittings', 'Adapters', 50, '[]'::jsonb, null, null, true, ''),
  ('other-fittings', 'hydraulic-fittings', 'Other fittings', 60, '[]'::jsonb, null, null, true, ''),
  ('filters', 'machine-systems', 'Filters', 50, '[{"key": "style", "label": "Style", "type": "choice", "filter": "chips", "choices": ["Spin-on", "Element", "Cartridge"]}, {"key": "thread_size", "label": "Thread size", "type": "text", "filter": "list"}, {"key": "od_in", "label": "Outside diameter", "type": "number", "filter": "range", "unit": "in"}, {"key": "length_in", "label": "Length", "type": "number", "filter": "range", "unit": "in"}, {"key": "gasket", "label": "Gasket", "type": "text", "filter": "list"}, {"key": "micron", "label": "Micron rating", "type": "number", "filter": "range", "unit": "µm"}, {"key": "micron_basis", "label": "Micron basis", "type": "choice", "filter": "chips", "choices": ["Nominal", "Absolute"]}, {"key": "bypass_psid", "label": "Bypass valve", "type": "text", "filter": "list"}, {"key": "anti_drainback", "label": "Anti-drainback valve", "type": "bool", "filter": "toggle"}, {"key": "media", "label": "Media", "type": "choice", "filter": "chips", "choices": ["Cellulose", "Synthetic", "Blend"]}]'::jsonb, 'part_number', 'parcel', false, ''),
  ('filters-engine-oil', 'filters', 'Engine oil', 10, '[]'::jsonb, null, null, false, ''),
  ('filters-fuel', 'filters', 'Fuel', 20, '[]'::jsonb, null, null, false, ''),
  ('filters-air', 'filters', 'Air', 30, '[]'::jsonb, null, null, false, ''),
  ('filters-hydraulic', 'filters', 'Hydraulic and transmission', 40, '[]'::jsonb, null, null, false, ''),
  ('filters-coolant', 'filters', 'Coolant', 50, '[]'::jsonb, null, null, false, ''),
  ('filters-breather-def', 'filters', 'Crankcase breather and DEF', 60, '[]'::jsonb, null, null, false, ''),
  ('lubricants', 'universal', 'Lubricants and fluids', 80, '[{"key": "viscosity", "label": "Viscosity grade", "type": "text", "filter": "list"}, {"key": "specs_met", "label": "Specs met", "type": "multi", "filter": "list"}, {"key": "claim", "label": "Claim strength", "type": "choice", "filter": "chips", "choices": ["OEM product", "OEM licensed", "Meets spec (maker’s claim)"]}, {"key": "base", "label": "Base", "type": "choice", "filter": "chips", "choices": ["Conventional", "Synthetic blend", "Full synthetic"]}, {"key": "nlgi", "label": "Grease grade", "type": "text", "filter": "list"}, {"key": "thickener", "label": "Grease thickener", "type": "text", "filter": "list"}, {"key": "coolant_type", "label": "Coolant type", "type": "choice", "filter": "chips", "choices": ["Conventional", "Extended life (OAT)", "Hybrid (HOAT)"]}, {"key": "mix", "label": "Mix", "type": "choice", "filter": "chips", "choices": ["Concentrate", "50/50 premix"]}]'::jsonb, 'spec', 'parcel', false, 'Container sizes are variants: one family, one item per container.'),
  ('lube-engine-oil', 'lubricants', 'Engine oil', 10, '[]'::jsonb, null, null, false, ''),
  ('lube-tractor-fluid', 'lubricants', 'Transmission and hydraulic (tractor fluid)', 20, '[]'::jsonb, null, null, false, ''),
  ('lube-hydraulic', 'lubricants', 'Hydraulic oil', 30, '[]'::jsonb, null, null, false, ''),
  ('lube-gear', 'lubricants', 'Gear oil', 40, '[]'::jsonb, null, null, false, ''),
  ('lube-grease', 'lubricants', 'Grease', 50, '[]'::jsonb, null, null, false, ''),
  ('lube-coolant', 'lubricants', 'Coolant and antifreeze', 60, '[]'::jsonb, null, null, false, ''),
  ('lube-def', 'lubricants', 'Diesel exhaust fluid (DEF)', 70, '[]'::jsonb, null, null, false, ''),
  ('belts', 'universal', 'Belts', 20, '[{"key": "belt_type", "label": "Belt type", "type": "choice", "filter": "chips", "choices": ["Classical", "Narrow", "Banded", "V-ribbed", "Variable speed"]}, {"key": "cross_section", "label": "Cross section", "type": "text", "filter": "list"}, {"key": "length_in", "label": "Length", "type": "number", "filter": "range", "unit": "in"}, {"key": "length_type", "label": "Length measured as", "type": "choice", "filter": "chips", "choices": ["Outside", "Effective", "Pitch"]}, {"key": "top_width", "label": "Top width", "type": "text", "filter": "list"}, {"key": "bands_ribs", "label": "Bands or ribs", "type": "number", "filter": "list"}, {"key": "construction", "label": "Construction", "type": "choice", "filter": "chips", "choices": ["Wrapped", "Raw-edge cogged", "Aramid cord"]}]'::jsonb, 'part_number', 'parcel', false, ''),
  ('belts-classical', 'belts', 'Classical V-belts', 10, '[]'::jsonb, null, null, false, ''),
  ('belts-narrow', 'belts', 'Narrow V-belts', 20, '[]'::jsonb, null, null, false, ''),
  ('belts-banded', 'belts', 'Banded belts', 30, '[]'::jsonb, null, null, false, ''),
  ('belts-ribbed', 'belts', 'V-ribbed belts', 40, '[]'::jsonb, null, null, false, ''),
  ('belts-variable-speed', 'belts', 'Variable-speed belts', 50, '[]'::jsonb, null, null, false, ''),
  ('belts-ag', 'belts', 'Agricultural belts (ASABE S211)', 60, '[]'::jsonb, null, null, false, ''),
  ('tires-drive', 'tire-types', 'Tractor drive (rear)', 10, '[]'::jsonb, null, null, false, ''),
  ('tires-steer', 'tire-types', 'Tractor steer (front)', 20, '[]'::jsonb, null, null, false, ''),
  ('tires-implement', 'tire-types', 'Implement and wagon', 30, '[]'::jsonb, null, null, false, ''),
  ('tires-combine-sprayer', 'tire-types', 'Combine and sprayer', 40, '[]'::jsonb, null, null, false, ''),
  ('tires-skid-steer', 'tire-types', 'Skid steer and loader', 50, '[]'::jsonb, null, null, false, ''),
  ('tires-turf', 'tire-types', 'Turf and compact', 60, '[]'::jsonb, null, null, false, ''),
  ('tires-tubes-ballast', 'tire-types', 'Tubes, valve stems, and ballast', 70, '[]'::jsonb, null, 'parcel', false, ''),
  ('tires-wheels', 'tires', 'Wheels and rims', 80, '[]'::jsonb, 'part_number', null, false, ''),
  ('tires-weights', 'tires', 'Weights', 90, '[]'::jsonb, 'part_number', null, false, ''),
  ('shop-supplies', 'universal', 'Shop supplies, safety, and cleaning', 90, '[]'::jsonb, 'none', 'parcel', false, ''),
  ('shop-safety', 'shop-supplies', 'Safety and PPE', 10, '[]'::jsonb, null, null, false, ''),
  ('ppe-gloves', 'shop-safety', 'Gloves', 10, '[{"key": "glove_size", "label": "Size", "type": "choice", "filter": "chips", "choices": ["S", "M", "L", "XL", "2XL", "3XL"]}, {"key": "material", "label": "Material", "type": "text", "filter": "list"}, {"key": "cut_level", "label": "Cut level", "type": "choice", "filter": "chips", "choices": ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9"]}, {"key": "cut_standard", "label": "Cut rating standard", "type": "text", "filter": "list", "note": "ANSI/ISEA 105 edition the rating was tested to"}, {"key": "coating", "label": "Coating", "type": "text", "filter": "list"}, {"key": "pack_count", "label": "Pack count", "type": "number", "filter": "list"}]'::jsonb, null, null, false, ''),
  ('ppe-eyewear', 'shop-safety', 'Eye protection', 20, '[{"key": "z87", "label": "ANSI Z87.1 rating", "type": "choice", "filter": "chips", "choices": ["Z87", "Z87+"]}, {"key": "tint", "label": "Lens tint", "type": "choice", "filter": "chips", "choices": ["Clear", "Gray", "Amber", "Mirror", "Shade 3", "Shade 5"]}, {"key": "otg", "label": "Fits over glasses", "type": "bool", "filter": "toggle"}]'::jsonb, null, null, false, ''),
  ('ppe-hearing', 'shop-safety', 'Hearing protection', 30, '[{"key": "hearing_type", "label": "Type", "type": "choice", "filter": "chips", "choices": ["Ear plugs", "Ear muffs", "Banded plugs"]}, {"key": "nrr", "label": "Noise reduction rating", "type": "number", "filter": "range", "unit": "dB"}]'::jsonb, null, null, false, ''),
  ('ppe-respiratory', 'shop-safety', 'Respiratory', 40, '[{"key": "rating", "label": "Rating", "type": "choice", "filter": "chips", "choices": ["N95", "P95", "P100", "Organic vapor"]}]'::jsonb, null, null, false, ''),
  ('ppe-hi-vis', 'shop-safety', 'High visibility', 50, '[{"key": "class", "label": "ANSI class", "type": "choice", "filter": "chips", "choices": ["Class 2", "Class 3", "Class E"]}, {"key": "apparel_size", "label": "Size", "type": "choice", "filter": "chips", "choices": ["S", "M", "L", "XL", "2XL", "3XL"]}]'::jsonb, null, null, false, ''),
  ('ppe-first-aid', 'shop-safety', 'First aid', 60, '[]'::jsonb, null, null, false, ''),
  ('shop-cleaning', 'shop-supplies', 'Cleaning and degreasing', 20, '[{"key": "use", "label": "Use", "type": "text", "filter": "list"}, {"key": "container", "label": "Container size", "type": "text", "filter": "list"}, {"key": "form", "label": "Form", "type": "choice", "filter": "chips", "choices": ["Aerosol", "Liquid", "Gel", "Powder"]}, {"key": "solvent", "label": "Base", "type": "choice", "filter": "chips", "choices": ["Water based", "Solvent based"]}]'::jsonb, null, null, false, ''),
  ('shop-absorbents', 'shop-supplies', 'Absorbents and spill control', 30, '[{"key": "absorbs", "label": "Absorbs", "type": "choice", "filter": "chips", "choices": ["Oil only", "Universal", "Hazmat"]}, {"key": "capacity", "label": "Capacity", "type": "text", "filter": "list"}]'::jsonb, null, null, false, ''),
  ('shop-sprays', 'shop-supplies', 'Chemical sprays', 40, '[{"key": "use", "label": "Use", "type": "text", "filter": "list"}, {"key": "container", "label": "Container size", "type": "text", "filter": "list"}, {"key": "form", "label": "Form", "type": "choice", "filter": "chips", "choices": ["Aerosol", "Liquid", "Gel", "Powder"]}, {"key": "solvent", "label": "Base", "type": "choice", "filter": "chips", "choices": ["Water based", "Solvent based"]}]'::jsonb, null, null, false, ''),
  ('shop-consumables', 'shop-supplies', 'Shop consumables', 50, '[{"key": "item_size", "label": "Size", "type": "text", "filter": "list"}, {"key": "pack_count", "label": "Pack count", "type": "number", "filter": "list"}]'::jsonb, null, null, false, ''),
  ('cab-glass', 'ms-cab', 'Cab glass and clear panels', 10, '[{"key": "position", "label": "Position", "type": "choice", "filter": "chips", "choices": ["Windshield", "Front door", "Door", "Left side", "Right side", "Rear", "Roof"]}, {"key": "material", "label": "Material", "type": "choice", "filter": "chips", "choices": ["Tempered glass", "Laminated glass", "Polycarbonate"]}, {"key": "coating", "label": "Coating", "type": "choice", "filter": "chips", "choices": ["Hard-coated both sides", "Hard-coated one side", "None"]}, {"key": "thickness", "label": "Thickness", "type": "text", "filter": "list"}, {"key": "tint", "label": "Tint", "type": "choice", "filter": "chips", "choices": ["Clear", "Green", "Gray", "Bronze"]}, {"key": "holes_hardware", "label": "Holes and hardware", "type": "text", "filter": "none"}, {"key": "frame", "label": "Fits frame", "type": "text", "filter": "none"}]'::jsonb, 'part_number', 'freight', false, ''),
  ('glass-tractor-combine', 'cab-glass', 'Tractor and combine cab glass', 10, '[]'::jsonb, null, null, false, ''),
  ('glass-skid-steer', 'cab-glass', 'Skid steer and track loader doors', 20, '[]'::jsonb, null, null, false, ''),
  ('glass-excavator-backhoe', 'cab-glass', 'Excavator and backhoe glass', 30, '[]'::jsonb, null, null, false, ''),
  ('glass-seals-hardware', 'cab-glass', 'Seals, gaskets, and glazing hardware', 40, '[]'::jsonb, null, 'parcel', false, '')
on conflict (id) do update set
  parent_id = excluded.parent_id,
  name = excluded.name,
  sort = excluded.sort,
  spec_fields = excluded.spec_fields,
  fitment = excluded.fitment,
  default_ship = excluded.default_ship,
  note = excluded.note;

-- The hydraulic fittings move onto the tree by their old type. Items already
-- placed in a category are left alone.
update shop.fittings_products set category_id = case type
    when 'orb-plug' then 'orb-plugs'
    when 'jic-cap' then 'jic-caps'
    when 'jic-plug' then 'jic-plugs'
    when 'breather-plug' then 'breather-plugs'
    when 'adapter' then 'adapters'
    else 'other-fittings'
  end
where category_id is null;

-- ---------------------------------------------------------------------------
-- Hydraulic hose builder: saved builds (each with our own tag number), the
-- requests customers send, and which places can build a hose and how fast.
-- ---------------------------------------------------------------------------

alter table shop.fittings_locations
  add column if not exists builds_hoses boolean not null default false,
  add column if not exists one_hour boolean not null default false,
  add column if not exists hours text not null default '',
  add column if not exists hose_lines text not null default '';

create table if not exists shop.fittings_hose_builds (
  tag text primary key check (tag ~ '^BH-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$'),
  spec jsonb not null check (jsonb_typeof(spec) = 'object'),
  source text not null default 'customer' check (source in ('customer','shop','oem')),
  -- OEM part numbers this build replaces, upper case letters and digits only.
  oem_numbers text[] not null default '{}',
  make text not null default '',
  model text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists fittings_hose_builds_oem_idx on shop.fittings_hose_builds using gin (oem_numbers);

create table if not exists shop.fittings_hose_requests (
  id uuid primary key default gen_random_uuid(),
  number bigint generated always as identity (start with 5001),
  tag text not null references shop.fittings_hose_builds(tag) on delete restrict,
  mode text not null check (mode in ('now','shop')),
  status text not null default 'new' check (status in ('new','sent','building','ready','done','cancelled')),
  name text not null default '',
  phone text not null default '',
  email text not null default '',
  zip text not null default '',
  machine text not null default '',
  notes text not null default '',
  builder_id uuid references shop.fittings_locations(id) on delete set null,
  created_at timestamptz not null default now(),
  check (phone <> '' or email <> '')
);
create index if not exists fittings_hose_requests_new_idx on shop.fittings_hose_requests(status, created_at desc);

alter table shop.fittings_hose_builds enable row level security;
alter table shop.fittings_hose_requests enable row level security;
revoke all on shop.fittings_hose_builds, shop.fittings_hose_requests from anon, authenticated;
grant all on shop.fittings_hose_builds, shop.fittings_hose_requests to service_role;


-- ---------------------------------------------------------------------------
-- Catalog foundation, part 2 (2026-11-25): what the leading parts sites taught
-- us. See "Parts Catalog Plan: What the Best Parts Sites Do".
--   condition, universal, warranty, price mode   on each product
--   machine kinds, serial prefixes and breaks    on each machine (Cat goes by prefix)
--   exploded diagrams                            empty until content is licensed
--   quote requests                               big components and pasted lists
--   trigram search on numbers and names          "86-572263" finds "86572263"
-- ---------------------------------------------------------------------------

alter table shop.fittings_products
  add column if not exists condition text not null default 'new',
  add column if not exists universal boolean not null default false,
  add column if not exists warranty_months integer,
  add column if not exists price_mode text not null default 'cart',
  -- Filled only from a supplier or OEM feed, never typed by hand.
  add column if not exists oem_list_price_cents integer;

do $$ begin
  alter table shop.fittings_products add constraint fittings_products_condition_chk
    check (condition in ('new','reman','rebuilt','used','surplus'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table shop.fittings_products add constraint fittings_products_price_mode_chk
    check (price_mode in ('cart','quote'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table shop.fittings_products add constraint fittings_products_warranty_chk
    check ((warranty_months is null or warranty_months between 0 and 120)
       and (oem_list_price_cents is null or oem_list_price_cents >= 0));
exception when duplicate_object then null; end $$;

alter table shop.fittings_machines
  -- Cat names a machine by a three-character serial prefix plus a number range.
  add column if not exists serial_prefixes text[] not null default '{}',
  -- [{serial, note}]: where the maker changed parts partway through a model.
  add column if not exists serial_breaks jsonb not null default '[]'::jsonb,
  add column if not exists sort integer not null default 0;

do $$ begin
  alter table shop.fittings_machines add constraint fittings_machines_kind_chk
    check (kind in ('tractor','combine','header','hay','planter','tillage','sprayer',
                    'backhoe','excavator','dozer','wheel-loader','skid-steer','track-loader','articulated-truck','other'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table shop.fittings_machines add constraint fittings_machines_breaks_chk
    check (jsonb_typeof(serial_breaks) = 'array' and (year_from is null or year_to is null or year_from <= year_to));
exception when duplicate_object then null; end $$;
create index if not exists fittings_machines_make_idx on shop.fittings_machines(make, kind, series);

alter table shop.fittings_fitment
  add column if not exists serial_prefix text not null default '';
alter table shop.fittings_fitment
  drop constraint if exists fittings_fitment_product_id_machine_id_position_serial_from_key;
do $$ begin
  alter table shop.fittings_fitment add constraint fittings_fitment_one_row
    unique (product_id, machine_id, position, serial_prefix, serial_from);
exception when duplicate_object or duplicate_table then null; end $$;
create index if not exists fittings_fitment_product_idx on shop.fittings_fitment(product_id);

create table if not exists shop.fittings_diagrams (
  id uuid primary key default gen_random_uuid(),
  machine_id uuid not null references shop.fittings_machines(id) on delete cascade,
  section text not null,
  title text not null,
  image_url text not null default '' check (image_url = '' or image_url ~ '^https?://'),
  -- Where the drawing came from, and the licence that lets us show it.
  source text not null default '',
  sort integer not null default 0
);
create index if not exists fittings_diagrams_machine_idx on shop.fittings_diagrams(machine_id, sort);

create table if not exists shop.fittings_diagram_parts (
  diagram_id uuid not null references shop.fittings_diagrams(id) on delete cascade,
  callout text not null,
  -- Either one of our items, or just the number the drawing lists.
  product_id text references shop.fittings_products(id) on delete set null,
  number text not null default '',
  number_norm text not null default '' check (number_norm = '' or number_norm ~ '^[A-Z0-9]+$'),
  qty integer not null default 1 check (qty > 0),
  note text not null default '',
  primary key (diagram_id, callout, number_norm)
);

create table if not exists shop.fittings_quote_requests (
  id uuid primary key default gen_random_uuid(),
  number bigint generated always as identity (start with 7001),
  -- [{number, qty, product_id?, note?}]: one line per part asked about.
  lines jsonb not null check (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) between 1 and 1000),
  source text not null default 'product' check (source in ('product','list','phone')),
  status text not null default 'new' check (status in ('new','quoted','won','lost','cancelled')),
  name text not null default '',
  company text not null default '',
  phone text not null default '',
  email text not null default '',
  zip text not null default '',
  machine text not null default '',
  notes text not null default '',
  created_at timestamptz not null default now(),
  check (phone <> '' or email <> '')
);
create index if not exists fittings_quote_requests_new_idx on shop.fittings_quote_requests(status, created_at desc);

alter table shop.fittings_diagrams enable row level security;
alter table shop.fittings_diagram_parts enable row level security;
alter table shop.fittings_quote_requests enable row level security;
do $$
declare t text;
begin
  foreach t in array array['fittings_diagrams','fittings_diagram_parts'] loop
    execute format('drop policy if exists "%s is public" on shop.%I', t, t);
    execute format('create policy "%s is public" on shop.%I for select to anon, authenticated using (true)', t, t);
  end loop;
end $$;
revoke all on shop.fittings_diagrams, shop.fittings_diagram_parts, shop.fittings_quote_requests from anon, authenticated;
grant select on shop.fittings_diagrams, shop.fittings_diagram_parts to anon, authenticated;
grant all on shop.fittings_diagrams, shop.fittings_diagram_parts, shop.fittings_quote_requests to service_role;

create extension if not exists pg_trgm with schema extensions;
create index if not exists fittings_xrefs_number_trgm on shop.fittings_xrefs using gin (number_norm extensions.gin_trgm_ops);
create index if not exists fittings_products_name_trgm on shop.fittings_products using gin (lower(name) extensions.gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Machine serial runs (2026-11-25): which machine, and which year or series of
-- it, a serial number belongs to. Loaded from the starter lineup sheet and
-- added to by the parts counter. Private: the store answers lookups, and does
-- not publish the table.
-- ---------------------------------------------------------------------------

create table if not exists shop.fittings_machine_serials (
  id uuid primary key default gen_random_uuid(),
  machine_id uuid not null references shop.fittings_machines(id) on delete cascade,
  prefix text not null default '' check (prefix ~ '^[A-Z0-9]{0,6}$'),
  serial_from text not null default '',
  serial_to text not null default '',
  year integer check (year is null or year between 1900 and 2100),
  note text not null default '',
  confidence text not null check (confidence in ('oem','reference','seller','single','observed')),
  source text not null default '',
  -- Which load wrote the row ("Starter lineup 2026-11-25"), so a load can be run again.
  batch text not null default '',
  check (serial_from <> '' or serial_to <> '' or prefix <> '')
);
create index if not exists fittings_machine_serials_machine_idx on shop.fittings_machine_serials(machine_id);
create index if not exists fittings_machine_serials_prefix_idx on shop.fittings_machine_serials(prefix);

alter table shop.fittings_machine_serials enable row level security;
revoke all on shop.fittings_machine_serials from anon, authenticated;
grant all on shop.fittings_machine_serials to service_role;

-- ---------------------------------------------------------------------------
-- Checkout rules (2026-11-26): cores and other charges at checkout, core
-- returns and their refunds, the same-day cutoff, pickup orders, and freight
-- carts sent for a quote instead of paid online.
--   Core credit: full within 30 days of the sale, 85% from day 31 to 60,
--   nothing after day 60 (lib/checkout-rules.ts).
-- ---------------------------------------------------------------------------
alter table shop.fittings_settings
  add column if not exists ship_cutoff text not null default '14:00',
  add column if not exists ship_tz text not null default 'America/Chicago';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fittings_settings_cutoff_ck') then
    alter table shop.fittings_settings add constraint fittings_settings_cutoff_ck
      check (ship_cutoff ~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fittings_settings_tz_ck') then
    alter table shop.fittings_settings add constraint fittings_settings_tz_ck
      check (ship_tz in ('America/New_York','America/Chicago','America/Denver','America/Los_Angeles'));
  end if;
end $$;

alter table shop.fittings_orders
  add column if not exists charges_cents integer not null default 0 check (charges_cents >= 0),
  add column if not exists ship_method text not null default 'parcel' check (ship_method in ('parcel','pickup'));

-- One row per item and kind of charge on an order: kept apart from the order
-- items so the stock count never moves for a charge.
create table if not exists shop.fittings_order_charges (
  id bigint generated always as identity primary key,
  order_id uuid not null references shop.fittings_orders(id) on delete cascade,
  product_id text not null,
  kind text not null check (kind in ('core','tire_fee','hazmat','deposit')),
  label text not null,
  unit_cents integer not null check (unit_cents >= 0),
  qty integer not null check (qty > 0),
  total_cents integer not null check (total_cents >= 0),
  refundable boolean not null default false,
  returned_qty integer not null default 0 check (returned_qty >= 0 and returned_qty <= qty),
  refunded_cents integer not null default 0 check (refunded_cents >= 0 and refunded_cents <= total_cents)
);
create index if not exists fittings_order_charges_order_idx on shop.fittings_order_charges(order_id);

-- Each core that comes back: how many days it took, what it earned, the refund.
create table if not exists shop.fittings_core_returns (
  id bigint generated always as identity primary key,
  charge_id bigint not null references shop.fittings_order_charges(id) on delete cascade,
  qty integer not null check (qty > 0),
  returned_on date not null,
  days integer not null check (days >= 0),
  credit_cents integer not null check (credit_cents >= 0),
  stripe_refund_id text,
  note text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists fittings_core_returns_charge_idx on shop.fittings_core_returns(charge_id);

alter table shop.fittings_order_charges enable row level security;
alter table shop.fittings_core_returns enable row level security;
revoke all on shop.fittings_order_charges, shop.fittings_core_returns from anon, authenticated;
grant all on shop.fittings_order_charges, shop.fittings_core_returns to service_role;

-- A cart that ships by truck becomes a quote request.
alter table shop.fittings_quote_requests drop constraint if exists fittings_quote_requests_source_check;
alter table shop.fittings_quote_requests add constraint fittings_quote_requests_source_check
  check (source in ('product','list','phone','freight'));
alter table shop.fittings_quote_requests
  add column if not exists answer text not null default '',
  add column if not exists updated_at timestamptz not null default now();

-- ---------------------------------------------------------------------------
-- Country of origin (2026-11-25). Seal kits start with made-in-USA aftermarket
-- lines; the shop shows a Made in USA badge and filter from this. Only mark an
-- item USA when the supplier states it for that item: the FTC's rule for an
-- unqualified "Made in USA" is all or virtually all of it made here.
-- ---------------------------------------------------------------------------
alter table shop.fittings_products
  add column if not exists origin text not null default '' check (length(origin) <= 40);
