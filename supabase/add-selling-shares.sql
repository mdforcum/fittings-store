-- ---------------------------------------------------------------------------
-- Selling shares, both ways.
--
-- Whoever makes the sale earns the selling share (settings.route_cut_bps,
-- 6%); whoever ships keeps the rest. When one dealer's store sells and a
-- different dealer ships, Backroad Iron also keeps a network fee
-- (settings.network_fee_bps, 2%). Both come out of what the shipping dealer
-- is owed.
--
--   sold by            shipped by        ledger
--   Backroad Iron      dealer            dealer pays 6% (routed)
--   dealer's store     same dealer       own-store fee only (storefront)
--   dealer's store     Backroad Iron     dealer earns 6% (referral)
--   dealer A's store   dealer B          A earns 6%; B pays 6% + 2% (network)
--
-- Each dealer has one line per order: parts it shipped, its shipping share,
-- what it pays (cut_cents: selling share or own-store fee; network_cents),
-- what it earns (referral_cents), its card fee share, and the net owed.
--
-- Needs add-routing.sql first. Safe to run more than once.
-- ---------------------------------------------------------------------------

alter table shop.fittings_settings add column if not exists network_fee_bps integer not null default 200;
do $$ begin
  alter table shop.fittings_settings add constraint fittings_settings_network_chk check (network_fee_bps between 0 and 5000);
exception when duplicate_object then null; end $$;
alter table shop.fittings_settings alter column route_cut_bps set default 600;
-- Rates chosen 2026-11-26: 6% selling share each way, 2% network fee.
update shop.fittings_settings set route_cut_bps = 600, network_fee_bps = 200
  where id = 1 and route_cut_bps = 1000 and network_fee_bps = 200;

alter table shop.fittings_settlements
  add column if not exists referral_cents integer not null default 0 check (referral_cents >= 0),
  add column if not exists network_bps integer not null default 0 check (network_bps between 0 and 5000),
  add column if not exists network_cents integer not null default 0 check (network_cents >= 0);
alter table shop.fittings_settlements drop constraint if exists fittings_settlements_kind_check;
alter table shop.fittings_settlements add constraint fittings_settlements_kind_check
  check (kind in ('routed', 'storefront', 'referral', 'network', 'mixed'));

create or replace function shop.fittings_settlements_guard()
returns trigger language plpgsql set search_path = shop, public, extensions as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'ledger rows are kept';
  end if;
  if (new.order_id, new.dealer_id, new.kind, new.parts_cents, new.shipping_cents, new.cut_bps, new.cut_cents,
      new.referral_cents, new.network_bps, new.network_cents, new.created_at)
     is distinct from (old.order_id, old.dealer_id, old.kind, old.parts_cents, old.shipping_cents, old.cut_bps, old.cut_cents,
      old.referral_cents, old.network_bps, old.network_cents, old.created_at) then
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

-- The card fee follows the money a dealer ships (parts and shipping); a
-- selling share earned on someone else's shipment carries none.
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
    net_cents = s.parts_cents + s.shipping_cents + s.referral_cents - s.cut_cents - s.network_cents
              - case when v_base > 0 then round(v_fee::numeric * (s.parts_cents + s.shipping_cents) / v_base)::integer else 0 end
  where s.order_id = p_order_id and s.card_fee_cents is null;
end; $$;

create or replace function shop.fittings_settle_order(p_order_id uuid)
returns void language plpgsql set search_path = shop, public, extensions as $$
declare
  v_house uuid := fittings_house_dealer();
  v_seller uuid;
  v_ship_total integer;
  v_parts integer;
  v_sell_bps integer;
  v_net_bps integer;
  v_own_bps integer;
  r record;
  v_shipped integer;
  v_ship integer;
  v_cut integer;
  v_cut_bps integer;
  v_network integer;
  v_network_bps integer;
  v_referral integer;
  v_kind text;
  v_by jsonb;
  v_all integer;
begin
  select case when o.dealer_id is distinct from v_house then o.dealer_id end, coalesce(o.shipping_cents, 0)
    into v_seller, v_ship_total from fittings_orders o where o.id = p_order_id;
  select route_cut_bps, coalesce(network_fee_bps, 0), storefront_fee_bps into v_sell_bps, v_net_bps, v_own_bps
    from fittings_settings where id = 1;
  select coalesce(sum(i.unit_price_cents * i.qty), 0) into v_parts from fittings_order_items i where i.order_id = p_order_id;

  -- Parts value shipped from each dealer's shelves (Backroad Iron's included), by dealer id.
  select coalesce(jsonb_object_agg(x.dealer_id::text, x.value), '{}'::jsonb) into v_by
  from (
    select l.dealer_id, sum(a.qty * coalesce((
             select round(sum(i.unit_price_cents * i.qty)::numeric / nullif(sum(i.qty), 0))
             from fittings_order_items i where i.order_id = p_order_id and i.product_id = a.product_id), 0))::integer as value
    from fittings_allocations a join fittings_locations l on l.id = a.location_id
    where a.order_id = p_order_id
    group by l.dealer_id
  ) x;
  select coalesce(sum(value::integer), 0) into v_all from jsonb_each_text(v_by) as e(key, value);

  for r in
    select d.dealer_id from (
      select key::uuid as dealer_id from jsonb_each_text(v_by) where key::uuid is distinct from v_house
      union select v_seller where v_seller is not null
    ) d
  loop
    v_shipped := coalesce((v_by->>(r.dealer_id::text))::integer, 0);
    v_ship := case when v_parts > 0 then round(v_ship_total::numeric * v_shipped / v_parts)::integer else 0 end;
    if r.dealer_id = v_seller then
      -- Its own sale: own-store fee on what it shipped, selling share on what others shipped.
      v_cut_bps := v_own_bps;
      v_cut := round(v_shipped::numeric * v_own_bps / 10000)::integer;
      v_network_bps := 0;
      v_network := 0;
      v_referral := round((v_all - v_shipped)::numeric * v_sell_bps / 10000)::integer;
    else
      -- It shipped for someone else's sale: the seller's share, plus the network fee when the seller is another dealer.
      v_cut_bps := v_sell_bps;
      v_cut := round(v_shipped::numeric * v_sell_bps / 10000)::integer;
      v_network_bps := case when v_seller is not null then v_net_bps else 0 end;
      v_network := round(v_shipped::numeric * v_network_bps / 10000)::integer;
      v_referral := 0;
    end if;
    v_kind := case
      when r.dealer_id = v_seller and v_shipped > 0 and v_referral > 0 then 'mixed'
      when r.dealer_id = v_seller and v_shipped > 0 then 'storefront'
      when r.dealer_id = v_seller then 'referral'
      when v_seller is null then 'routed'
      else 'network' end;
    if v_shipped > 0 or v_referral > 0 then
      insert into fittings_settlements (order_id, dealer_id, kind, parts_cents, shipping_cents, cut_bps, cut_cents,
                                        referral_cents, network_bps, network_cents)
      values (p_order_id, r.dealer_id, v_kind, v_shipped, v_ship, v_cut_bps, v_cut, v_referral, v_network_bps, v_network)
      on conflict (order_id, dealer_id) do nothing;
    end if;
  end loop;
  perform fittings_settle_fee(p_order_id);
end; $$;

revoke all on function shop.fittings_settle_fee(uuid) from public, anon, authenticated;
revoke all on function shop.fittings_settle_order(uuid) from public, anon, authenticated;
grant execute on function shop.fittings_settle_fee(uuid) to service_role;
grant execute on function shop.fittings_settle_order(uuid) to service_role;

notify pgrst, 'reload schema';
