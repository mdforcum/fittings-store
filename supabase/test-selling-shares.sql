-- Checks for add-selling-shares.sql (scratch database with every shop change
-- loaded, items a and b):
--   psql -v ON_ERROR_STOP=1 -d <scratch> -f supabase/test-selling-shares.sql
begin;

create or replace function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if not coalesce(ok, false) then raise exception 'FAILED: %', what; end if;
  raise notice 'pass: %', what;
end $$;
create or replace function pg_temp.dealer(text) returns uuid language sql as $$ select id from shop.fittings_dealers where slug = $1 $$;
create or replace function pg_temp.loc(text) returns uuid language sql as $$ select id from shop.fittings_locations where kind = 'store' and code = $1 $$;
create or replace function pg_temp.new_order(uuid, uuid, boolean) returns void language sql as $$
  insert into shop.fittings_orders (id, status, ship_method, dealer_id, own_stock_only) values ($1, 'pending', 'parcel', $2, $3);
$$;
create or replace function pg_temp.line(uuid, text, int) returns void language sql as $$
  insert into shop.fittings_order_items (order_id, product_id, name, unit_price_cents, qty) values ($1, $2, 'Part', 1000, $3);
$$;
create or replace function pg_temp.pay(uuid) returns boolean language sql as $$
  select shop.fittings_fulfill_order($1, jsonb_build_object('ship_to', jsonb_build_object('zip', '62565', 'state', 'IL'), 'shipping_cents', 0,
    'subtotal_cents', (select sum(unit_price_cents * qty) from shop.fittings_order_items where order_id = $1), 'card_fee_cents', 0));
$$;
-- dealer slug: kind parts ship paid(cut) network earned net
create or replace function pg_temp.lines(uuid) returns text language sql as $$
  select string_agg(d.slug || ': ' || s.kind || ' parts ' || s.parts_cents || ' pays ' || s.cut_cents || '+' || s.network_cents
                    || ' earns ' || s.referral_cents || ' net ' || coalesce(s.net_cents::text, '?'), '; ' order by d.slug)
  from shop.fittings_settlements s join shop.fittings_dealers d on d.id = s.dealer_id where s.order_id = $1;
$$;

select pg_temp.check((select route_cut_bps = 600 and network_fee_bps = 200 from shop.fittings_settings where id = 1),
  'the rates are 6% selling share each way and 2% network');

-- Three dealers: Backroad Iron (MAIN), McCormick (MCD), Arthur Ag (ART); routing on.
insert into shop.fittings_dealers (name, slug) values ('Arthur Ag', 'arthur-ag');
update shop.fittings_locations set zip = '62565', state = 'IL' where code = 'MAIN';
insert into shop.fittings_locations (name, kind, dealer_id, code, state, zip, takes_routed) values
  ('McCormick shop', 'store', pg_temp.dealer('mccormick-diesel'), 'MCD', 'IL', '61951', true),
  ('Arthur yard', 'store', pg_temp.dealer('arthur-ag'), 'ART', 'IL', '61911', true);
update shop.fittings_settings set route_orders = true where id = 1;
delete from shop.fittings_onhand where product_id in ('a', 'b');

-- 1. Backroad Iron sells, McCormick ships.
insert into shop.fittings_onhand (product_id, location_id, qty) values ('a', pg_temp.loc('MCD'), 1);
select pg_temp.new_order('00000000-0000-4000-8000-0000000000a1', null::uuid, false);
select pg_temp.line('00000000-0000-4000-8000-0000000000a1', 'a', 1);
select pg_temp.check(pg_temp.pay('00000000-0000-4000-8000-0000000000a1'), 'order 1 paid');
select pg_temp.check(pg_temp.lines('00000000-0000-4000-8000-0000000000a1') = 'mccormick-diesel: routed parts 1000 pays 60+0 earns 0 net 940',
  'Backroad Iron sold, McCormick shipped: McCormick pays Backroad Iron 6%');

-- 2. McCormick's every-part store sells, Backroad Iron ships.
insert into shop.fittings_onhand (product_id, location_id, qty) values ('a', pg_temp.loc('MAIN'), 2)
  on conflict (product_id, location_id) do update set qty = 2;
select pg_temp.new_order('00000000-0000-4000-8000-0000000000a2', pg_temp.dealer('mccormick-diesel'), false);
select pg_temp.line('00000000-0000-4000-8000-0000000000a2', 'a', 2);
select pg_temp.check(pg_temp.pay('00000000-0000-4000-8000-0000000000a2'), 'order 2 paid');
select pg_temp.check(pg_temp.lines('00000000-0000-4000-8000-0000000000a2') = 'mccormick-diesel: referral parts 0 pays 0+0 earns 120 net 120',
  'McCormick sold, Backroad Iron shipped: Backroad Iron pays McCormick 6%');

-- 3. McCormick's store sells, Arthur Ag ships.
insert into shop.fittings_onhand (product_id, location_id, qty) values ('b', pg_temp.loc('ART'), 1);
select pg_temp.new_order('00000000-0000-4000-8000-0000000000a3', pg_temp.dealer('mccormick-diesel'), false);
select pg_temp.line('00000000-0000-4000-8000-0000000000a3', 'b', 1);
select pg_temp.check(pg_temp.pay('00000000-0000-4000-8000-0000000000a3'), 'order 3 paid');
select pg_temp.check(pg_temp.lines('00000000-0000-4000-8000-0000000000a3')
  = 'arthur-ag: network parts 1000 pays 60+20 earns 0 net 920; mccormick-diesel: referral parts 0 pays 0+0 earns 60 net 60',
  'McCormick sold, Arthur shipped: Arthur pays McCormick 6% and Backroad Iron 2%');

-- 4. McCormick's store sells two parts: one off its own shelf, one off Backroad Iron's.
insert into shop.fittings_onhand (product_id, location_id, qty) values ('b', pg_temp.loc('MCD'), 1), ('a', pg_temp.loc('MAIN'), 1)
  on conflict (product_id, location_id) do update set qty = excluded.qty;
select pg_temp.new_order('00000000-0000-4000-8000-0000000000a4', pg_temp.dealer('mccormick-diesel'), false);
select pg_temp.line('00000000-0000-4000-8000-0000000000a4', 'a', 1);
select pg_temp.line('00000000-0000-4000-8000-0000000000a4', 'b', 1);
select pg_temp.check(pg_temp.pay('00000000-0000-4000-8000-0000000000a4'), 'order 4 paid');
select pg_temp.check(pg_temp.lines('00000000-0000-4000-8000-0000000000a4') = 'mccormick-diesel: mixed parts 1000 pays 0+0 earns 60 net 1060',
  'its own part is its own sale; Backroad Iron''s part earns it 6%');

-- 5. Backroad Iron sells and ships its own: no lines.
select pg_temp.new_order('00000000-0000-4000-8000-0000000000a5', null::uuid, false);
select pg_temp.line('00000000-0000-4000-8000-0000000000a5', 'a', 1);
update shop.fittings_onhand set qty = 1 where product_id = 'a' and location_id = pg_temp.loc('MAIN');
select pg_temp.check(pg_temp.pay('00000000-0000-4000-8000-0000000000a5') and pg_temp.lines('00000000-0000-4000-8000-0000000000a5') is null,
  'Backroad Iron selling and shipping its own writes no dealer lines');

-- The card fee follows what a dealer ships, not what it earns.
select pg_temp.new_order('00000000-0000-4000-8000-0000000000a6', pg_temp.dealer('mccormick-diesel'), false);
select pg_temp.line('00000000-0000-4000-8000-0000000000a6', 'b', 1);
insert into shop.fittings_onhand (product_id, location_id, qty) values ('b', pg_temp.loc('ART'), 1)
  on conflict (product_id, location_id) do update set qty = 1;
select shop.fittings_fulfill_order('00000000-0000-4000-8000-0000000000a6', jsonb_build_object('ship_to', jsonb_build_object('zip', '61911', 'state', 'IL'),
  'shipping_cents', 1000, 'subtotal_cents', 1000, 'card_fee_cents', 100));
select pg_temp.check((select string_agg(d.slug || ' fee ' || s.card_fee_cents || ' net ' || s.net_cents, '; ' order by d.slug)
  from shop.fittings_settlements s join shop.fittings_dealers d on d.id = s.dealer_id where s.order_id = '00000000-0000-4000-8000-0000000000a6')
  = 'arthur-ag fee 100 net 1820; mccormick-diesel fee 0 net 60', 'the shipper carries the card fee; the seller''s share is clear');

rollback;
select 'all passed';
