-- ---------------------------------------------------------------------------
-- Storefronts: one backend, many branded stores.
--
-- A storefront is a web address (parts.mccormickdiesel.com) with a name, logo
-- and colors. A storefront tied to a dealer shows only the parts at that
-- dealer's store locations, and its orders are filled only from them. With no
-- storefront for the address, the store is the Backroad Iron store showing
-- every dealer's parts, as before.
--
-- Orders remember the storefront and dealer they came through.
--
-- Needs add-stock-holds.sql and add-locations.sql first. Safe to run more
-- than once.
-- ---------------------------------------------------------------------------

create table if not exists shop.fittings_storefronts (
  id uuid primary key default gen_random_uuid(),
  dealer_id uuid references shop.fittings_dealers(id) on delete restrict,
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 40),
  host text unique check (host is null or (host = lower(host) and host ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$')),
  name text not null check (length(btrim(name)) between 1 and 60),
  tagline text not null default '',
  phone text not null default '',
  email text not null default '',
  logo_url text not null default '',
  color_header text not null default '#1a1a1a' check (color_header ~ '^#[0-9a-f]{6}$'),
  color_accent text not null default '#e81820' check (color_accent ~ '^#[0-9a-f]{6}$'),
  color_button text not null default '#b3121a' check (color_button ~ '^#[0-9a-f]{6}$'),
  live boolean not null default false,
  created_at timestamptz not null default now()
);

alter table shop.fittings_orders
  add column if not exists storefront_id uuid references shop.fittings_storefronts(id) on delete set null,
  add column if not exists dealer_id uuid references shop.fittings_dealers(id) on delete set null;

-- McCormick Diesel: dealer and storefront, not live until their address and stock are in.
insert into shop.fittings_dealers (name, slug) values ('McCormick Diesel', 'mccormick-diesel')
  on conflict (slug) do nothing;
insert into shop.fittings_storefronts (dealer_id, slug, host, name, tagline, phone, logo_url)
select d.id, 'mccormick-diesel', 'parts.mccormickdiesel.com', 'McCormick Diesel', 'Parts on the shelf, ready to go',
       '217-682-3339', '/brands/mccormick-diesel.png'
from shop.fittings_dealers d where d.slug = 'mccormick-diesel'
on conflict (slug) do nothing;

-- What a dealer can sell right now: its store locations' counts less what is
-- held in checkouts on its own storefront. Totals only, by item.
create or replace function shop.fittings_dealer_stock(p_dealer uuid)
returns table (product_id text, qty integer)
language sql stable security definer set search_path = shop, public, extensions as $$
  select o.product_id,
         greatest(sum(o.qty)::integer - coalesce((
           select sum(h.qty)::integer from fittings_holds h join fittings_orders od on od.id = h.order_id
           where h.product_id = o.product_id and h.ended_at is null and h.expires_at > now() and od.dealer_id = p_dealer), 0), 0)
  from fittings_onhand o join fittings_locations l on l.id = o.location_id
  where l.kind = 'store' and l.dealer_id = p_dealer
  group by o.product_id;
$$;

-- Holding: as before, and a dealer storefront's order must also fit within
-- that dealer's own stock.
create or replace function shop.fittings_hold_order(p_order_id uuid, p_minutes integer)
returns jsonb language plpgsql set search_path = shop, public, extensions as $$
declare
  r record;
  v_have integer;
  v_held integer;
  v_dealer uuid;
  v_dealer_have integer;
  v_dealer_held integer;
  v_free integer;
  v_problems jsonb := '[]'::jsonb;
  v_until timestamptz := now() + make_interval(mins => p_minutes);
begin
  if p_minutes is null or p_minutes < 1 or p_minutes > 1500 then
    raise exception 'hold minutes out of range';
  end if;
  select dealer_id into v_dealer from fittings_orders where id = p_order_id and status = 'pending';
  if not found then
    return jsonb_build_object('ok', false, 'problems', '[]'::jsonb, 'reason', 'not_pending');
  end if;

  update fittings_holds set ended_at = now(), end_reason = 'expired'
    where ended_at is null and expires_at <= now();

  for r in
    select product_id, sum(qty)::integer as qty
    from fittings_order_items where order_id = p_order_id
    group by product_id order by product_id
  loop
    select qty into v_have from fittings_products where id = r.product_id for update;
    select coalesce(sum(qty), 0) into v_held from fittings_holds
      where product_id = r.product_id and ended_at is null and expires_at > now()
        and order_id <> p_order_id;
    v_free := coalesce(v_have, 0) - v_held;
    if v_dealer is not null then
      select coalesce(sum(o.qty), 0) into v_dealer_have
        from fittings_onhand o join fittings_locations l on l.id = o.location_id
        where o.product_id = r.product_id and l.kind = 'store' and l.dealer_id = v_dealer;
      select coalesce(sum(h.qty), 0) into v_dealer_held
        from fittings_holds h join fittings_orders od on od.id = h.order_id
        where h.product_id = r.product_id and h.ended_at is null and h.expires_at > now()
          and h.order_id <> p_order_id and od.dealer_id = v_dealer;
      v_free := least(v_free, v_dealer_have - v_dealer_held);
    end if;
    if v_have is null or v_free < r.qty then
      v_problems := v_problems || jsonb_build_object('id', r.product_id, 'available', greatest(v_free, 0));
    end if;
  end loop;

  if jsonb_array_length(v_problems) > 0 then
    return jsonb_build_object('ok', false, 'problems', v_problems);
  end if;

  update fittings_holds set ended_at = now(), end_reason = 'released'
    where order_id = p_order_id and ended_at is null;
  insert into fittings_holds (order_id, product_id, qty, expires_at)
  select p_order_id, product_id, sum(qty)::integer, v_until
    from fittings_order_items where order_id = p_order_id group by product_id;
  return jsonb_build_object('ok', true, 'expires_at', v_until);
end; $$;

-- Paying: as in add-locations.sql, but an order from a dealer's storefront is
-- filled only from that dealer's store locations.
create or replace function shop.fittings_fulfill_order(p_order_id uuid, p_details jsonb)
returns boolean language plpgsql set search_path = shop, public, extensions as $$
declare
  v_short boolean := false;
  v_one uuid;
  v_pickup boolean;
  v_dealer uuid;
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
  returning ship_method = 'pickup', dealer_id into v_pickup, v_dealer;
  if not found then
    return false;
  end if;

  perform 1 from fittings_onhand
    where product_id in (select product_id from fittings_order_items where order_id = p_order_id)
    order by product_id, location_id for update;

  select l2.id into v_one
  from fittings_locations l2
  where l2.kind = 'store' and l2.active and (case when v_pickup then l2.pickup else l2.ships end)
    and (v_dealer is null or l2.dealer_id = v_dealer)
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
      where o.product_id = r.product_id and o.qty > 0 and (v_dealer is null or l3.dealer_id = v_dealer)
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

alter table shop.fittings_storefronts enable row level security;
revoke all on shop.fittings_storefronts from anon, authenticated;
grant all on shop.fittings_storefronts to service_role;

revoke all on function shop.fittings_dealer_stock(uuid) from public;
grant execute on function shop.fittings_dealer_stock(uuid) to anon, authenticated, service_role;
revoke all on function shop.fittings_hold_order(uuid, integer) from public, anon, authenticated;
revoke all on function shop.fittings_fulfill_order(uuid, jsonb) from public, anon, authenticated;
grant execute on function shop.fittings_hold_order(uuid, integer) to service_role;
grant execute on function shop.fittings_fulfill_order(uuid, jsonb) to service_role;

notify pgrst, 'reload schema';
