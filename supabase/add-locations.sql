-- ---------------------------------------------------------------------------
-- Dealers and store locations: a count for each item at each location.
--
-- A dealer (Backroad Iron, later McCormick Diesel) has store locations. Each
-- item has a count at each store location in fittings_onhand. The item's
-- fittings_products.qty stays the total and is kept equal to the sum by the
-- database; nothing else needs to add it up.
--
-- Anything that still sets fittings_products.qty directly (an older screen, a
-- survey) is not refused: the change is applied to the default location, so
-- the total and the per-location counts never drift apart.
--
-- Paying for an order assigns each item to the location it comes from
-- (fittings_allocations): one location that has everything if there is one,
-- the default location first; otherwise each item from wherever it is.
--
-- Stock history rows now say which location changed. Older rows, from before
-- locations, have no location.
--
-- Needs add-stock-holds.sql first. Safe to run more than once.
-- ---------------------------------------------------------------------------

-- Dealers -------------------------------------------------------------------

create table if not exists shop.fittings_dealers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 80),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 40),
  created_at timestamptz not null default now()
);
insert into shop.fittings_dealers (name, slug) values ('Backroad Iron', 'backroad-iron')
  on conflict (slug) do nothing;

-- Store locations -----------------------------------------------------------

alter table shop.fittings_locations
  add column if not exists dealer_id uuid references shop.fittings_dealers(id) on delete restrict,
  add column if not exists code text not null default '',
  add column if not exists city text not null default '',
  add column if not exists state text not null default '',
  add column if not exists zip text not null default '',
  add column if not exists ships boolean not null default true,
  add column if not exists pickup boolean not null default true,
  add column if not exists active boolean not null default true,
  add column if not exists sort integer not null default 0;

alter table shop.fittings_locations drop constraint if exists fittings_locations_kind_chk;
alter table shop.fittings_locations add constraint fittings_locations_kind_chk
  check (kind in ('survey','dealer','supplier','store'));
do $$ begin
  alter table shop.fittings_locations add constraint fittings_locations_store_dealer_chk
    check (kind <> 'store' or dealer_id is not null);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table shop.fittings_locations add constraint fittings_locations_code_chk
    check (code ~ '^[A-Z0-9]{0,6}$');
exception when duplicate_object then null; end $$;
create unique index if not exists fittings_locations_store_code_idx
  on shop.fittings_locations(dealer_id, code) where kind = 'store' and code <> '';

-- The first store: where today's stock is.
insert into shop.fittings_locations (name, kind, dealer_id, code, sort)
select 'Main shop', 'store', d.id, 'MAIN', 0
from shop.fittings_dealers d
where d.slug = 'backroad-iron'
  and not exists (select 1 from shop.fittings_locations where kind = 'store');

alter table shop.fittings_settings
  add column if not exists default_location_id uuid references shop.fittings_locations(id) on delete set null;
update shop.fittings_settings s set default_location_id = (
  select id from shop.fittings_locations where kind = 'store' order by sort, created_at limit 1)
where s.id = 1 and s.default_location_id is null;

-- Where new stock goes when no location is named: the default store location,
-- else the first active one.
create or replace function shop.fittings_default_location()
returns uuid language sql stable set search_path = shop, public, extensions as $$
  select coalesce(
    (select s.default_location_id from fittings_settings s
       join fittings_locations l on l.id = s.default_location_id and l.kind = 'store' and l.active
      where s.id = 1),
    (select id from fittings_locations where kind = 'store' and active order by sort, created_at limit 1),
    (select id from fittings_locations where kind = 'store' order by sort, created_at limit 1));
$$;

-- Counts by location ---------------------------------------------------------

create table if not exists shop.fittings_onhand (
  product_id text not null references shop.fittings_products(id) on delete cascade,
  location_id uuid not null references shop.fittings_locations(id) on delete restrict,
  qty integer not null default 0 check (qty >= 0),
  updated_at timestamptz not null default now(),
  primary key (product_id, location_id)
);
create index if not exists fittings_onhand_location_idx on shop.fittings_onhand(location_id);

alter table shop.fittings_stock_moves add column if not exists location_id uuid;
alter table shop.fittings_stock_moves drop constraint if exists fittings_stock_moves_kind_check;
alter table shop.fittings_stock_moves add constraint fittings_stock_moves_kind_check
  check (kind in ('start','receive','count','adjust','edit','sale','return','transfer'));

-- Today's counts become the main shop's counts. History already has them.
insert into shop.fittings_onhand (product_id, location_id, qty)
select p.id, shop.fittings_default_location(), p.qty
from shop.fittings_products p
where p.qty > 0 and shop.fittings_default_location() is not null
  and not exists (select 1 from shop.fittings_onhand o where o.product_id = p.id);

-- Every change to a location's count: one history line, then the item's total
-- is set to the sum. Flags (transaction-local) let a caller say why
-- (shop.move_kind/_order/_note), skip the line (shop.no_log) or skip the total
-- because it already set it (shop.no_sync).
create or replace function shop.fittings_onhand_changed()
returns trigger language plpgsql set search_path = shop, public, extensions as $$
declare
  v_pid text := coalesce(new.product_id, old.product_id);
  v_loc uuid := coalesce(new.location_id, old.location_id);
  v_old integer := case when tg_op = 'INSERT' then 0 else old.qty end;
  v_new integer := case when tg_op = 'DELETE' then 0 else new.qty end;
begin
  if tg_op <> 'DELETE' and not exists (select 1 from fittings_locations where id = v_loc and kind = 'store') then
    raise exception 'stock can only be kept at a store location';
  end if;
  if v_new = v_old then return null; end if;
  if coalesce(current_setting('shop.no_log', true), '') <> 'on' then
    insert into fittings_stock_moves (product_id, location_id, delta, qty_after, kind, order_id, note)
    values (v_pid, v_loc, v_new - v_old, v_new,
            coalesce(nullif(current_setting('shop.move_kind', true), ''), 'edit'),
            nullif(current_setting('shop.move_order', true), '')::uuid,
            coalesce(current_setting('shop.move_note', true), ''));
  end if;
  if coalesce(current_setting('shop.no_sync', true), '') <> 'on' then
    perform set_config('shop.syncing', 'on', true);
    update fittings_products
      set qty = (select coalesce(sum(qty), 0) from fittings_onhand where product_id = v_pid), updated_at = now()
      where id = v_pid;
    perform set_config('shop.syncing', '', true);
  end if;
  return null;
end; $$;
drop trigger if exists fittings_onhand_changed on shop.fittings_onhand;
create trigger fittings_onhand_changed after insert or update or delete on shop.fittings_onhand
  for each row execute function shop.fittings_onhand_changed();

-- Takes up to p_qty of an item, the given location first (if any), then the
-- default, then the rest by sort. Returns how many it took. Leaves the total
-- to the caller's no_sync choice.
create or replace function shop.fittings_take(p_id text, p_qty integer, p_first uuid)
returns integer language plpgsql set search_path = shop, public, extensions as $$
declare
  r record;
  v_left integer := p_qty;
  v_take integer;
  v_default uuid := fittings_default_location();
begin
  for r in
    select o.location_id, o.qty from fittings_onhand o join fittings_locations l on l.id = o.location_id
    where o.product_id = p_id and o.qty > 0
    order by (o.location_id = p_first) desc nulls last, (o.location_id = v_default) desc nulls last, l.sort, l.created_at
    for update of o
  loop
    exit when v_left <= 0;
    v_take := least(r.qty, v_left);
    update fittings_onhand set qty = qty - v_take, updated_at = now()
      where product_id = p_id and location_id = r.location_id;
    v_left := v_left - v_take;
  end loop;
  return p_qty - v_left;
end; $$;

-- Direct changes to an item's total go to the default location.
create or replace function shop.fittings_products_qty_route()
returns trigger language plpgsql set search_path = shop, public, extensions as $$
declare
  v_delta integer;
  v_loc uuid;
  v_taken integer;
begin
  if coalesce(current_setting('shop.syncing', true), '') = 'on' then
    return new;
  end if;
  v_delta := new.qty - old.qty;
  if v_delta = 0 then return new; end if;
  v_loc := fittings_default_location();
  if v_loc is null then
    return new; -- no store location yet: nothing to keep in step
  end if;
  perform set_config('shop.no_sync', 'on', true);
  if v_delta > 0 then
    insert into fittings_onhand (product_id, location_id, qty) values (new.id, v_loc, v_delta)
      on conflict (product_id, location_id) do update set qty = fittings_onhand.qty + excluded.qty, updated_at = now();
    new.qty := old.qty + v_delta;
  else
    v_taken := fittings_take(new.id, -v_delta, v_loc);
    new.qty := old.qty - v_taken;
  end if;
  perform set_config('shop.no_sync', '', true);
  return new;
end; $$;

create or replace function shop.fittings_products_qty_start()
returns trigger language plpgsql set search_path = shop, public, extensions as $$
declare v_loc uuid := fittings_default_location();
begin
  if new.qty > 0 and v_loc is not null then
    perform set_config('shop.no_sync', 'on', true);
    perform set_config('shop.move_kind', coalesce(nullif(current_setting('shop.move_kind', true), ''), 'start'), true);
    insert into fittings_onhand (product_id, location_id, qty) values (new.id, v_loc, new.qty)
      on conflict (product_id, location_id) do nothing;
    perform set_config('shop.move_kind', '', true);
    perform set_config('shop.no_sync', '', true);
  end if;
  return null;
end; $$;

-- The history line now comes from the location count, not the total.
drop trigger if exists fittings_log_stock on shop.fittings_products;
drop trigger if exists fittings_products_qty_route on shop.fittings_products;
create trigger fittings_products_qty_route before update of qty on shop.fittings_products
  for each row execute function shop.fittings_products_qty_route();
drop trigger if exists fittings_products_qty_start on shop.fittings_products;
create trigger fittings_products_qty_start after insert on shop.fittings_products
  for each row execute function shop.fittings_products_qty_start();

-- Stock changes, by location ---------------------------------------------------

drop function if exists shop.fittings_adjust_qty(text, integer, text, text);
create or replace function shop.fittings_adjust_qty(p_id text, p_delta integer, p_kind text default 'adjust',
                                                   p_note text default '', p_location uuid default null)
returns integer language plpgsql set search_path = shop, public, extensions as $$
declare v_loc uuid := coalesce(p_location, fittings_default_location()); v integer;
begin
  if p_kind not in ('receive','count','adjust','return') then raise exception 'unknown stock change'; end if;
  if v_loc is null then raise exception 'add a store location first'; end if;
  perform set_config('shop.move_kind', p_kind, true);
  perform set_config('shop.move_note', left(coalesce(p_note, ''), 200), true);
  if p_delta > 0 then
    insert into fittings_onhand (product_id, location_id, qty) values (p_id, v_loc, p_delta)
      on conflict (product_id, location_id) do update set qty = fittings_onhand.qty + excluded.qty, updated_at = now();
  elsif p_delta < 0 then
    update fittings_onhand set qty = greatest(qty + p_delta, 0), updated_at = now()
      where product_id = p_id and location_id = v_loc;
  end if;
  perform set_config('shop.move_kind', '', true);
  perform set_config('shop.move_note', '', true);
  select qty into v from fittings_products where id = p_id;
  return v;
end; $$;

drop function if exists shop.fittings_count_qty(text, integer, text);
create or replace function shop.fittings_count_qty(p_id text, p_qty integer, p_note text default '', p_location uuid default null)
returns integer language plpgsql set search_path = shop, public, extensions as $$
declare v_loc uuid := coalesce(p_location, fittings_default_location()); v integer;
begin
  if p_qty is null or p_qty < 0 then raise exception 'a count must be 0 or more'; end if;
  if v_loc is null then raise exception 'add a store location first'; end if;
  perform set_config('shop.move_kind', 'count', true);
  perform set_config('shop.move_note', left(coalesce(p_note, ''), 200), true);
  insert into fittings_onhand (product_id, location_id, qty) values (p_id, v_loc, p_qty)
    on conflict (product_id, location_id) do update set qty = excluded.qty, updated_at = now();
  perform set_config('shop.move_kind', '', true);
  perform set_config('shop.move_note', '', true);
  select qty into v from fittings_products where id = p_id;
  return v;
end; $$;

create or replace function shop.fittings_transfer(p_id text, p_from uuid, p_to uuid, p_qty integer, p_note text default '')
returns integer language plpgsql set search_path = shop, public, extensions as $$
declare v_have integer;
begin
  if p_qty is null or p_qty < 1 then raise exception 'move at least one'; end if;
  if p_from = p_to then raise exception 'pick two different locations'; end if;
  select qty into v_have from fittings_onhand where product_id = p_id and location_id = p_from for update;
  if coalesce(v_have, 0) < p_qty then
    raise exception 'only % there to move', coalesce(v_have, 0);
  end if;
  perform set_config('shop.move_kind', 'transfer', true);
  perform set_config('shop.move_note', left(coalesce(p_note, ''), 200), true);
  update fittings_onhand set qty = qty - p_qty, updated_at = now() where product_id = p_id and location_id = p_from;
  insert into fittings_onhand (product_id, location_id, qty) values (p_id, p_to, p_qty)
    on conflict (product_id, location_id) do update set qty = fittings_onhand.qty + excluded.qty, updated_at = now();
  perform set_config('shop.move_kind', '', true);
  perform set_config('shop.move_note', '', true);
  return p_qty;
end; $$;

-- Where each paid item comes from ------------------------------------------------

create table if not exists shop.fittings_allocations (
  order_id uuid not null references shop.fittings_orders(id) on delete cascade,
  product_id text not null,
  location_id uuid not null references shop.fittings_locations(id) on delete restrict,
  qty integer not null check (qty > 0),
  primary key (order_id, product_id, location_id)
);
create index if not exists fittings_allocations_location_idx on shop.fittings_allocations(location_id);

-- Paying: mark the order paid, end its holds as sold, and take the parts from
-- one location that has them all (the default first), else from wherever each
-- part is. Each take is a sale line in the history; where it came from is kept
-- in fittings_allocations. All or nothing; safe to call twice.
create or replace function shop.fittings_fulfill_order(p_order_id uuid, p_details jsonb)
returns boolean language plpgsql set search_path = shop, public, extensions as $$
declare
  v_short boolean := false;
  v_one uuid;
  v_pickup boolean;
  v_default uuid := fittings_default_location();
  r record;
  l record;
  v_left integer;
  v_take integer;
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
  where id = p_order_id and status in ('pending', 'expired')
  returning ship_method = 'pickup' into v_pickup;
  if not found then
    return false;
  end if;

  -- Lock every count this order could draw on, in a fixed order.
  perform 1 from fittings_onhand
    where product_id in (select product_id from fittings_order_items where order_id = p_order_id)
    order by product_id, location_id for update;

  -- One location with everything: the default first, then by sort.
  select l2.id into v_one
  from fittings_locations l2
  where l2.kind = 'store' and l2.active and (case when v_pickup then l2.pickup else l2.ships end)
    and not exists (
      select 1 from (select product_id, sum(qty) as need from fittings_order_items where order_id = p_order_id group by product_id) n
      where coalesce((select o.qty from fittings_onhand o where o.product_id = n.product_id and o.location_id = l2.id), 0) < n.need)
  order by (l2.id = v_default) desc nulls last, l2.sort, l2.created_at
  limit 1;

  perform set_config('shop.move_kind', 'sale', true);
  perform set_config('shop.move_order', p_order_id::text, true);
  perform set_config('shop.move_note', '', true);

  for r in
    select product_id, sum(qty)::integer as need from fittings_order_items
    where order_id = p_order_id group by product_id order by product_id
  loop
    v_left := r.need;
    for l in
      select o.location_id, o.qty from fittings_onhand o join fittings_locations l3 on l3.id = o.location_id
      where o.product_id = r.product_id and o.qty > 0
      order by (o.location_id = v_one) desc nulls last, (o.location_id = v_default) desc nulls last, l3.sort, l3.created_at
    loop
      exit when v_left <= 0;
      v_take := least(l.qty, v_left);
      update fittings_onhand set qty = qty - v_take, updated_at = now()
        where product_id = r.product_id and location_id = l.location_id;
      insert into fittings_allocations (order_id, product_id, location_id, qty)
        values (p_order_id, r.product_id, l.location_id, v_take)
        on conflict (order_id, product_id, location_id) do update set qty = fittings_allocations.qty + excluded.qty;
      v_left := v_left - v_take;
    end loop;
    if v_left > 0 then
      v_short := true;
    end if;
  end loop;

  update fittings_holds set ended_at = now(), end_reason = 'sold'
    where order_id = p_order_id and ended_at is null;

  perform set_config('shop.move_kind', '', true);
  perform set_config('shop.move_order', '', true);

  if v_short then
    update fittings_orders set stock_short = true where id = p_order_id;
  end if;
  return true;
end; $$;

-- Access ---------------------------------------------------------------------

alter table shop.fittings_dealers enable row level security;
alter table shop.fittings_onhand enable row level security;
alter table shop.fittings_allocations enable row level security;
revoke all on shop.fittings_dealers, shop.fittings_onhand, shop.fittings_allocations from anon, authenticated;
grant all on shop.fittings_dealers, shop.fittings_onhand, shop.fittings_allocations to service_role;

revoke all on function shop.fittings_default_location() from public, anon, authenticated;
revoke all on function shop.fittings_take(text, integer, uuid) from public, anon, authenticated;
revoke all on function shop.fittings_adjust_qty(text, integer, text, text, uuid) from public, anon, authenticated;
revoke all on function shop.fittings_count_qty(text, integer, text, uuid) from public, anon, authenticated;
revoke all on function shop.fittings_transfer(text, uuid, uuid, integer, text) from public, anon, authenticated;
revoke all on function shop.fittings_fulfill_order(uuid, jsonb) from public, anon, authenticated;
grant execute on function shop.fittings_default_location() to service_role;
grant execute on function shop.fittings_take(text, integer, uuid) to service_role;
grant execute on function shop.fittings_adjust_qty(text, integer, text, text, uuid) to service_role;
grant execute on function shop.fittings_count_qty(text, integer, text, uuid) to service_role;
grant execute on function shop.fittings_transfer(text, uuid, uuid, integer, text) to service_role;
grant execute on function shop.fittings_fulfill_order(uuid, jsonb) to service_role;

notify pgrst, 'reload schema';
