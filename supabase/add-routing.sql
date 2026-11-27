-- ---------------------------------------------------------------------------
-- Routing Backroad Iron orders to dealers, and the dealer ledger.
--
-- Backroad Iron sells; a dealer may ship. Who can fill what:
--   * the house dealer's own locations (settings.house_dealer_id, Backroad
--     Iron) always fill Backroad Iron orders;
--   * other dealers' locations fill them only when the location has opted in
--     (fittings_locations.takes_routed) and routing is on
--     (settings.route_orders);
--   * a dealer's own store fills from its own shelves first; a store showing
--     every part also draws on the same pool as Backroad Iron;
--   * pickup orders stay at the counter the shopper bought from: Backroad
--     Iron's locations, or the dealer's own.
-- The Backroad Iron store (and a store showing every part) lists only what
-- that pool holds, so a dealer's parts appear on Backroad Iron only after it
-- opts in.
--
-- Order of choice when filling: one location that has the whole order (the
-- dealer's own first, then nearest the customer), else part by part, nearest
-- first. "Nearest" is the customer's own mail region (first three ZIP digits),
-- then the same state, then the rest.
--
-- Every paid order writes one ledger row per outside dealer whose shelf
-- shipped parts (fittings_settlements): the parts value, its share of the
-- shipping, Backroad Iron's cut, its share of the card fee, and the net owed.
-- Rows are kept; only the card fee (once known) and the paid date are filled
-- in later.
--
-- Needs the stock-holds, locations, storefronts and storefront-options changes
-- first. Safe to run more than once.
-- ---------------------------------------------------------------------------

alter table shop.fittings_settings
  add column if not exists house_dealer_id uuid references shop.fittings_dealers(id) on delete set null,
  add column if not exists route_orders boolean not null default false,
  add column if not exists route_cut_bps integer not null default 1000,
  add column if not exists storefront_fee_bps integer not null default 0;
do $$ begin
  alter table shop.fittings_settings add constraint fittings_settings_cut_chk
    check (route_cut_bps between 0 and 5000 and storefront_fee_bps between 0 and 5000);
exception when duplicate_object then null; end $$;
update shop.fittings_settings set house_dealer_id = (select id from shop.fittings_dealers where slug = 'backroad-iron')
  where id = 1 and house_dealer_id is null;

alter table shop.fittings_locations add column if not exists takes_routed boolean not null default false;
alter table shop.fittings_orders add column if not exists card_fee_cents integer check (card_fee_cents is null or card_fee_cents >= 0);

-- Which locations may fill an order -------------------------------------------

create or replace function shop.fittings_house_dealer()
returns uuid language sql stable set search_path = shop, public, extensions as $$
  select coalesce((select house_dealer_id from fittings_settings where id = 1),
                  (select id from fittings_dealers where slug = 'backroad-iron'));
$$;

-- p_dealer: the store's dealer (null: Backroad Iron's store). p_own: only that
-- dealer's shelves. p_pickup: a counter pickup.
create or replace function shop.fittings_may_fill(p_location uuid, p_dealer uuid, p_own boolean, p_pickup boolean)
returns boolean language sql stable set search_path = shop, public, extensions as $$
  select exists (
    select 1 from fittings_locations l
    where l.id = p_location and l.kind = 'store' and l.active
      and case
        when p_own then l.dealer_id = p_dealer
        when p_pickup then l.dealer_id = coalesce(p_dealer, fittings_house_dealer())
        else l.dealer_id = fittings_house_dealer()
             or l.dealer_id = p_dealer
             or (l.takes_routed and coalesce((select route_orders from fittings_settings where id = 1), false))
      end);
$$;

-- Closer is higher: 2 same mail region, 1 same state, 0 otherwise.
create or replace function shop.fittings_nearness(p_location uuid, p_zip text, p_state text)
returns integer language sql stable set search_path = shop, public, extensions as $$
  select case
    when coalesce(p_zip, '') ~ '^\d{3}' and left(l.zip, 3) = left(p_zip, 3) then 2
    when coalesce(p_state, '') <> '' and upper(l.state) = upper(p_state) then 1
    else 0 end
  from fittings_locations l where l.id = p_location;
$$;

-- What a store can sell from the shared pool: Backroad Iron's store (p_dealer
-- null) or a store showing every part. Pool counts less holds that draw on
-- the pool (holds of own-shelf orders from dealers outside the pool don't).
create or replace function shop.fittings_pool_stock(p_dealer uuid)
returns table (product_id text, qty integer)
language sql stable security definer set search_path = shop, public, extensions as $$
  with pool as (
    select l.id, l.dealer_id from fittings_locations l
    where fittings_may_fill(l.id, p_dealer, false, false)
  ), have as (
    select o.product_id, sum(o.qty)::integer as qty from fittings_onhand o join pool on pool.id = o.location_id group by o.product_id
  ), held as (
    select h.product_id, sum(h.qty)::integer as qty
    from fittings_holds h join fittings_orders od on od.id = h.order_id
    where h.ended_at is null and h.expires_at > now()
      and not (od.own_stock_only and od.dealer_id is not null and od.dealer_id not in (select dealer_id from pool))
    group by h.product_id
  )
  select have.product_id, greatest(have.qty - coalesce(held.qty, 0), 0) from have left join held using (product_id);
$$;

-- Shelf counts for the shoppers' location filter on a pool store.
create or replace function shop.fittings_pool_location_stock(p_dealer uuid)
returns table (location_id uuid, location_name text, city text, state text, dealer_name text, product_id text, qty integer)
language sql stable security definer set search_path = shop, public, extensions as $$
  select l.id, l.name, l.city, l.state, d.name, o.product_id, o.qty
  from fittings_onhand o
  join fittings_locations l on l.id = o.location_id
  join fittings_dealers d on d.id = l.dealer_id
  where o.qty > 0 and fittings_may_fill(l.id, p_dealer, false, false)
  order by l.sort, l.name;
$$;

-- Holding -----------------------------------------------------------------------

create or replace function shop.fittings_hold_order(p_order_id uuid, p_minutes integer)
returns jsonb language plpgsql set search_path = shop, public, extensions as $$
declare
  r record;
  v_have integer;
  v_held integer;
  v_dealer uuid;
  v_own boolean;
  v_pool_have integer;
  v_pool_held integer;
  v_free integer;
  v_problems jsonb := '[]'::jsonb;
  v_until timestamptz := now() + make_interval(mins => p_minutes);
begin
  if p_minutes is null or p_minutes < 1 or p_minutes > 1500 then
    raise exception 'hold minutes out of range';
  end if;
  select dealer_id, own_stock_only into v_dealer, v_own
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
      where product_id = r.product_id and ended_at is null and expires_at > now() and order_id <> p_order_id;
    v_free := coalesce(v_have, 0) - v_held;
    if v_own then
      select coalesce(sum(o.qty), 0) into v_pool_have
        from fittings_onhand o join fittings_locations l on l.id = o.location_id
        where o.product_id = r.product_id and l.kind = 'store' and l.dealer_id = v_dealer;
      select coalesce(sum(h.qty), 0) into v_pool_held
        from fittings_holds h join fittings_orders od on od.id = h.order_id
        where h.product_id = r.product_id and h.ended_at is null and h.expires_at > now()
          and h.order_id <> p_order_id and od.dealer_id = v_dealer and od.own_stock_only;
    else
      select coalesce(sum(o.qty), 0) into v_pool_have
        from fittings_onhand o
        where o.product_id = r.product_id and fittings_may_fill(o.location_id, v_dealer, false, false);
      select coalesce(sum(h.qty), 0) into v_pool_held
        from fittings_holds h join fittings_orders od on od.id = h.order_id
        where h.product_id = r.product_id and h.ended_at is null and h.expires_at > now() and h.order_id <> p_order_id
          and not (od.own_stock_only and od.dealer_id is not null and not exists (
            select 1 from fittings_locations l2 where l2.dealer_id = od.dealer_id and fittings_may_fill(l2.id, v_dealer, false, false)));
    end if;
    v_free := least(v_free, v_pool_have - v_pool_held);
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

-- The dealer ledger ---------------------------------------------------------------

create table if not exists shop.fittings_settlements (
  order_id uuid not null references shop.fittings_orders(id) on delete restrict,
  dealer_id uuid not null references shop.fittings_dealers(id) on delete restrict,
  kind text not null check (kind in ('routed', 'storefront')),
  parts_cents integer not null check (parts_cents >= 0),
  shipping_cents integer not null check (shipping_cents >= 0),
  cut_bps integer not null check (cut_bps between 0 and 5000),
  cut_cents integer not null check (cut_cents >= 0),
  card_fee_cents integer check (card_fee_cents is null or card_fee_cents >= 0),
  net_cents integer,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  paid_note text not null default '',
  primary key (order_id, dealer_id)
);
create index if not exists fittings_settlements_dealer_idx on shop.fittings_settlements(dealer_id, created_at);

-- A ledger row is written once. Later, only the card fee and net (once each,
-- when the fee becomes known) and the paid date and note (once) are filled in.
create or replace function shop.fittings_settlements_guard()
returns trigger language plpgsql set search_path = shop, public, extensions as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'ledger rows are kept';
  end if;
  if (new.order_id, new.dealer_id, new.kind, new.parts_cents, new.shipping_cents, new.cut_bps, new.cut_cents, new.created_at)
     is distinct from (old.order_id, old.dealer_id, old.kind, old.parts_cents, old.shipping_cents, old.cut_bps, old.cut_cents, old.created_at) then
    raise exception 'a ledger row''s amounts can''t be changed';
  end if;
  if old.card_fee_cents is not null and new.card_fee_cents is distinct from old.card_fee_cents then
    raise exception 'the card fee is already recorded';
  end if;
  if old.net_cents is not null and new.net_cents is distinct from old.net_cents then
    raise exception 'the net is already recorded';
  end if;
  if old.paid_at is not null and (new.paid_at is distinct from old.paid_at or new.paid_note is distinct from old.paid_note) then
    raise exception 'already marked paid';
  end if;
  return new;
end; $$;
drop trigger if exists fittings_settlements_guard on shop.fittings_settlements;
create trigger fittings_settlements_guard before update or delete on shop.fittings_settlements
  for each row execute function shop.fittings_settlements_guard();

-- The card fee's share for each dealer row of an order, once the fee is known.
create or replace function shop.fittings_settle_fee(p_order_id uuid)
returns void language plpgsql set search_path = shop, public, extensions as $$
declare
  v_fee integer;
  v_base integer;
begin
  select card_fee_cents, coalesce(subtotal_cents, 0) + coalesce(shipping_cents, 0) + coalesce(charges_cents, 0)
    into v_fee, v_base from fittings_orders where id = p_order_id;
  if v_fee is null then return; end if;
  update fittings_settlements s set
    card_fee_cents = case when v_base > 0 then round(v_fee::numeric * (s.parts_cents + s.shipping_cents) / v_base)::integer else 0 end,
    net_cents = s.parts_cents - s.cut_cents + s.shipping_cents
              - case when v_base > 0 then round(v_fee::numeric * (s.parts_cents + s.shipping_cents) / v_base)::integer else 0 end
  where s.order_id = p_order_id and s.card_fee_cents is null;
end; $$;

-- Writes the ledger rows for a paid order, from where its parts were taken.
create or replace function shop.fittings_settle_order(p_order_id uuid)
returns void language plpgsql set search_path = shop, public, extensions as $$
declare
  v_house uuid := fittings_house_dealer();
  v_order record;
  v_parts integer;
  r record;
  v_ship integer;
  v_bps integer;
begin
  select o.id, o.dealer_id, coalesce(o.shipping_cents, 0) as shipping_cents into v_order
    from fittings_orders o where o.id = p_order_id;
  select coalesce(sum(i.unit_price_cents * i.qty), 0) into v_parts from fittings_order_items i where i.order_id = p_order_id;
  for r in
    select l.dealer_id, sum(a.qty * coalesce((
             select round(sum(i.unit_price_cents * i.qty)::numeric / nullif(sum(i.qty), 0))
             from fittings_order_items i where i.order_id = p_order_id and i.product_id = a.product_id), 0))::integer as value
    from fittings_allocations a join fittings_locations l on l.id = a.location_id
    where a.order_id = p_order_id and l.dealer_id is distinct from v_house
    group by l.dealer_id
  loop
    v_ship := case when v_parts > 0 then round(v_order.shipping_cents::numeric * r.value / v_parts)::integer else 0 end;
    select case when r.dealer_id = v_order.dealer_id then storefront_fee_bps else route_cut_bps end into v_bps
      from fittings_settings where id = 1;
    insert into fittings_settlements (order_id, dealer_id, kind, parts_cents, shipping_cents, cut_bps, cut_cents)
    values (p_order_id, r.dealer_id,
            case when r.dealer_id = v_order.dealer_id then 'storefront' else 'routed' end,
            r.value, v_ship, coalesce(v_bps, 0), round(r.value::numeric * coalesce(v_bps, 0) / 10000)::integer)
    on conflict (order_id, dealer_id) do nothing;
  end loop;
  perform fittings_settle_fee(p_order_id);
end; $$;

-- Records the card fee when it is learned after payment, and fills in the ledger.
create or replace function shop.fittings_record_card_fee(p_order_id uuid, p_fee integer)
returns void language plpgsql set search_path = shop, public, extensions as $$
begin
  if p_fee is null or p_fee < 0 then raise exception 'fee must be 0 or more'; end if;
  update fittings_orders set card_fee_cents = p_fee where id = p_order_id and card_fee_cents is null;
  perform fittings_settle_fee(p_order_id);
end; $$;

-- Paying ---------------------------------------------------------------------------

create or replace function shop.fittings_fulfill_order(p_order_id uuid, p_details jsonb)
returns boolean language plpgsql set search_path = shop, public, extensions as $$
declare
  v_short boolean := false;
  v_one uuid;
  v_pickup boolean;
  v_dealer uuid;
  v_only boolean;
  v_zip text;
  v_state text;
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
    total_cents = coalesce((p_details->>'total_cents')::integer, total_cents),
    card_fee_cents = coalesce((p_details->>'card_fee_cents')::integer, card_fee_cents)
  where id = p_order_id and status in ('pending', 'expired')
  returning ship_method = 'pickup', dealer_id, own_stock_only, ship_to->>'zip', ship_to->>'state'
    into v_pickup, v_dealer, v_only, v_zip, v_state;
  if not found then
    return false;
  end if;

  perform 1 from fittings_onhand
    where product_id in (select product_id from fittings_order_items where order_id = p_order_id)
    order by product_id, location_id for update;

  -- One location that has the whole order: the store's dealer first, then nearest.
  select l2.id into v_one
  from fittings_locations l2
  where fittings_may_fill(l2.id, v_dealer, v_only, v_pickup)
    and (case when v_pickup then l2.pickup else l2.ships end)
    and not exists (
      select 1 from (select product_id, sum(qty) as need from fittings_order_items where order_id = p_order_id group by product_id) n
      where coalesce((select o.qty from fittings_onhand o where o.product_id = n.product_id and o.location_id = l2.id), 0) < n.need)
  order by (l2.dealer_id = v_dealer) desc nulls last, fittings_nearness(l2.id, v_zip, v_state) desc,
           (l2.id = v_default) desc nulls last, l2.sort, l2.created_at
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
      where o.product_id = r.product_id and o.qty > 0 and fittings_may_fill(o.location_id, v_dealer, v_only, v_pickup)
      order by (o.location_id = v_one) desc nulls last, (l3.dealer_id = v_dealer) desc nulls last,
               fittings_nearness(o.location_id, v_zip, v_state) desc, (o.location_id = v_default) desc nulls last,
               l3.sort, l3.created_at
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
  perform fittings_settle_order(p_order_id);
  return true;
end; $$;

-- Access -------------------------------------------------------------------------

alter table shop.fittings_settlements enable row level security;
revoke all on shop.fittings_settlements from anon, authenticated;
grant select, insert, update on shop.fittings_settlements to service_role;

revoke all on function shop.fittings_house_dealer() from public;
revoke all on function shop.fittings_may_fill(uuid, uuid, boolean, boolean) from public;
revoke all on function shop.fittings_nearness(uuid, text, text) from public;
grant execute on function shop.fittings_house_dealer() to anon, authenticated, service_role;
grant execute on function shop.fittings_may_fill(uuid, uuid, boolean, boolean) to anon, authenticated, service_role;
grant execute on function shop.fittings_nearness(uuid, text, text) to service_role;
revoke all on function shop.fittings_pool_stock(uuid) from public;
revoke all on function shop.fittings_pool_location_stock(uuid) from public;
grant execute on function shop.fittings_pool_stock(uuid) to anon, authenticated, service_role;
grant execute on function shop.fittings_pool_location_stock(uuid) to anon, authenticated, service_role;
revoke all on function shop.fittings_settle_fee(uuid) from public, anon, authenticated;
revoke all on function shop.fittings_settle_order(uuid) from public, anon, authenticated;
revoke all on function shop.fittings_record_card_fee(uuid, integer) from public, anon, authenticated;
revoke all on function shop.fittings_hold_order(uuid, integer) from public, anon, authenticated;
revoke all on function shop.fittings_fulfill_order(uuid, jsonb) from public, anon, authenticated;
grant execute on function shop.fittings_settle_fee(uuid) to service_role;
grant execute on function shop.fittings_settle_order(uuid) to service_role;
grant execute on function shop.fittings_record_card_fee(uuid, integer) to service_role;
grant execute on function shop.fittings_hold_order(uuid, integer) to service_role;
grant execute on function shop.fittings_fulfill_order(uuid, jsonb) to service_role;

notify pgrst, 'reload schema';
