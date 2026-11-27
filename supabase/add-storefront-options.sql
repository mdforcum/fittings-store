-- ---------------------------------------------------------------------------
-- Storefront options: what stock a store shows, a location filter for
-- shoppers, and a dealer's own shipping charges.
--
-- stock_scope   'own'     only the dealer's own shelves (as before)
--               'network' every part on Backroad Iron; the dealer's own
--                         shelves are used first when an order is filled
-- location_filter         shoppers may pick a location and see only the
--                         parts physically on the shelf there
-- ship_own                the dealer's shipping charges below, instead of
--                         Backroad Iron's (flat per order, free over an
--                         amount, order minimum)
--
-- The Backroad Iron store's own location filter is settings.location_filter.
-- Orders remember whether they had to come from the dealer's own shelves.
--
-- Needs add-storefronts.sql first. Safe to run more than once.
-- ---------------------------------------------------------------------------

alter table shop.fittings_storefronts
  add column if not exists stock_scope text not null default 'own',
  add column if not exists location_filter boolean not null default false,
  add column if not exists ship_own boolean not null default false,
  add column if not exists ship_flat_cents integer not null default 800,
  add column if not exists free_ship_over_cents integer,
  add column if not exists order_min_cents integer not null default 0;
do $$ begin
  alter table shop.fittings_storefronts add constraint fittings_storefronts_scope_chk check (stock_scope in ('own', 'network'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table shop.fittings_storefronts add constraint fittings_storefronts_ship_chk
    check (ship_flat_cents between 0 and 100000 and order_min_cents between 0 and 1000000
           and (free_ship_over_cents is null or free_ship_over_cents between 0 and 10000000));
exception when duplicate_object then null; end $$;

alter table shop.fittings_settings add column if not exists location_filter boolean not null default false;
alter table shop.fittings_orders add column if not exists own_stock_only boolean not null default false;
-- Orders placed through a dealer's store before this change came from its own shelves.
update shop.fittings_orders set own_stock_only = true where dealer_id is not null and not own_stock_only;

-- What is on the shelf at each open store location, for the shoppers' location
-- filter: one dealer's locations, or every dealer's when p_dealer is null.
-- Counts and the location's public name and town only.
create or replace function shop.fittings_location_stock(p_dealer uuid)
returns table (location_id uuid, location_name text, city text, state text, dealer_name text, product_id text, qty integer)
language sql stable security definer set search_path = shop, public, extensions as $$
  select l.id, l.name, l.city, l.state, d.name, o.product_id, o.qty
  from fittings_onhand o
  join fittings_locations l on l.id = o.location_id
  join fittings_dealers d on d.id = l.dealer_id
  where l.kind = 'store' and l.active and o.qty > 0
    and (p_dealer is null or l.dealer_id = p_dealer)
  order by l.sort, l.name;
$$;

-- Holding: an order that must come from the dealer's own shelves has to fit there too.
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
  select case when own_stock_only then dealer_id end into v_dealer
    from fittings_orders where id = p_order_id and status = 'pending';
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
          and h.order_id <> p_order_id and od.dealer_id = v_dealer and od.own_stock_only;
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

-- A dealer's own counts less holds on its own-shelf orders (for an 'own' store).
create or replace function shop.fittings_dealer_stock(p_dealer uuid)
returns table (product_id text, qty integer)
language sql stable security definer set search_path = shop, public, extensions as $$
  select o.product_id,
         greatest(sum(o.qty)::integer - coalesce((
           select sum(h.qty)::integer from fittings_holds h join fittings_orders od on od.id = h.order_id
           where h.product_id = o.product_id and h.ended_at is null and h.expires_at > now()
             and od.dealer_id = p_dealer and od.own_stock_only), 0), 0)
  from fittings_onhand o join fittings_locations l on l.id = o.location_id
  where l.kind = 'store' and l.dealer_id = p_dealer
  group by o.product_id;
$$;

-- Paying: an own-shelf order comes only from the dealer's locations; any other
-- dealer order uses the dealer's own locations first, then the rest.
create or replace function shop.fittings_fulfill_order(p_order_id uuid, p_details jsonb)
returns boolean language plpgsql set search_path = shop, public, extensions as $$
declare
  v_short boolean := false;
  v_one uuid;
  v_pickup boolean;
  v_dealer uuid;
  v_only boolean;
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
  returning ship_method = 'pickup', dealer_id, own_stock_only into v_pickup, v_dealer, v_only;
  if not found then
    return false;
  end if;

  perform 1 from fittings_onhand
    where product_id in (select product_id from fittings_order_items where order_id = p_order_id)
    order by product_id, location_id for update;

  select l2.id into v_one
  from fittings_locations l2
  where l2.kind = 'store' and l2.active and (case when v_pickup then l2.pickup else l2.ships end)
    and (not v_only or l2.dealer_id = v_dealer)
    and not exists (
      select 1 from (select product_id, sum(qty) as need from fittings_order_items where order_id = p_order_id group by product_id) n
      where coalesce((select o.qty from fittings_onhand o where o.product_id = n.product_id and o.location_id = l2.id), 0) < n.need)
  order by (l2.dealer_id = v_dealer) desc nulls last, (l2.id = v_default) desc nulls last, l2.sort, l2.created_at
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
      where o.product_id = r.product_id and o.qty > 0 and (not v_only or l3.dealer_id = v_dealer)
      order by (o.location_id = v_one) desc nulls last, (l3.dealer_id = v_dealer) desc nulls last,
               (o.location_id = v_default) desc nulls last, l3.sort, l3.created_at
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

revoke all on function shop.fittings_location_stock(uuid) from public;
grant execute on function shop.fittings_location_stock(uuid) to anon, authenticated, service_role;
revoke all on function shop.fittings_dealer_stock(uuid) from public;
grant execute on function shop.fittings_dealer_stock(uuid) to anon, authenticated, service_role;
revoke all on function shop.fittings_hold_order(uuid, integer) from public, anon, authenticated;
revoke all on function shop.fittings_fulfill_order(uuid, jsonb) from public, anon, authenticated;
grant execute on function shop.fittings_hold_order(uuid, integer) to service_role;
grant execute on function shop.fittings_fulfill_order(uuid, jsonb) to service_role;

notify pgrst, 'reload schema';
