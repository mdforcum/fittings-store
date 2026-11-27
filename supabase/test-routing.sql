-- Checks for add-routing.sql (scratch database with every shop change loaded,
-- items a and b):
--   psql -v ON_ERROR_STOP=1 -d <scratch> -f supabase/test-routing.sql
begin;

create or replace function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if not coalesce(ok, false) then raise exception 'FAILED: %', what; end if;
  raise notice 'pass: %', what;
end $$;
create or replace function pg_temp.dealer(text) returns uuid language sql as $$ select id from shop.fittings_dealers where slug = $1 $$;
create or replace function pg_temp.loc(text) returns uuid language sql as $$ select id from shop.fittings_locations where kind = 'store' and code = $1 $$;
create or replace function pg_temp.from_(uuid) returns text language sql as $$
  select string_agg(l.code || 'x' || a.qty, ',' order by l.code) from shop.fittings_allocations a join shop.fittings_locations l on l.id = a.location_id where a.order_id = $1 $$;
create or replace function pg_temp.pool(text) returns integer language sql as $$ select coalesce((select qty from shop.fittings_pool_stock(null) where product_id = $1), 0) $$;
create or replace function pg_temp.new_order(uuid, text, int, text, uuid, boolean) returns void language sql as $$
  insert into shop.fittings_orders (id, status, ship_method, dealer_id, own_stock_only) values ($1, 'pending', $4, $5, $6);
  insert into shop.fittings_order_items (order_id, product_id, name, unit_price_cents, qty) values ($1, $2, 'Part', 1000, $3);
$$;
create or replace function pg_temp.pay(uuid, text, text, int) returns boolean language sql as $$
  select shop.fittings_fulfill_order($1, jsonb_build_object('ship_to', jsonb_build_object('zip', $2, 'state', $3), 'shipping_cents', 1200,
    'subtotal_cents', (select sum(unit_price_cents * qty) from shop.fittings_order_items where order_id = $1), 'card_fee_cents', $4));
$$;

select pg_temp.check((select not route_orders and route_cut_bps = 1000 and storefront_fee_bps = 0 and house_dealer_id = pg_temp.dealer('backroad-iron')
  from shop.fittings_settings where id = 1), 'routing starts off, with a 10% cut and Backroad Iron as the house');

-- Main shop in Shelbyville; McCormick's shop in Sullivan.
update shop.fittings_locations set zip = '62565', state = 'IL', city = 'Shelbyville' where code = 'MAIN';
insert into shop.fittings_locations (name, kind, dealer_id, code, city, state, zip) values ('McCormick shop', 'store', pg_temp.dealer('mccormick-diesel'), 'MCD', 'Sullivan', 'IL', '61951');
delete from shop.fittings_onhand where product_id in ('a', 'b');
insert into shop.fittings_onhand (product_id, location_id, qty) values ('a', pg_temp.loc('MAIN'), 5), ('a', pg_temp.loc('MCD'), 4), ('b', pg_temp.loc('MCD'), 2);

select pg_temp.check(pg_temp.pool('a') = 5 and pg_temp.pool('b') = 0, 'Backroad Iron''s store shows only its own stock before dealers opt in');
update shop.fittings_locations set takes_routed = true where code = 'MCD';
select pg_temp.check(pg_temp.pool('a') = 5, 'opting in does nothing while routing is off');
update shop.fittings_settings set route_orders = true where id = 1;
select pg_temp.check(pg_temp.pool('a') = 9 and pg_temp.pool('b') = 2, 'with routing on, an opted-in dealer''s parts join Backroad Iron''s store');
select pg_temp.check((select count(distinct location_id) from shop.fittings_pool_location_stock(null)) = 2, 'and its location joins the shoppers'' location filter');

-- Nearest wins.
select pg_temp.new_order('00000000-0000-4000-8000-0000000000f1', 'a', 1, 'parcel', null::uuid, false);
select pg_temp.check(pg_temp.pay('00000000-0000-4000-8000-0000000000f1', '61951', 'IL', 59), 'a Backroad Iron order from Sullivan is paid');
select pg_temp.check(pg_temp.from_('00000000-0000-4000-8000-0000000000f1') = 'MCDx1', 'it goes to the dealer in the customer''s area');
select pg_temp.new_order('00000000-0000-4000-8000-0000000000f2', 'a', 1, 'parcel', null::uuid, false);
select pg_temp.check(pg_temp.pay('00000000-0000-4000-8000-0000000000f2', '62565', 'IL', 59), 'a Backroad Iron order from Shelbyville is paid');
select pg_temp.check(pg_temp.from_('00000000-0000-4000-8000-0000000000f2') = 'MAINx1', 'it goes to Backroad Iron''s own shop nearby');

-- The ledger.
select pg_temp.check((select kind || ' parts ' || parts_cents || ' ship ' || shipping_cents || ' cut ' || cut_cents || ' fee ' || card_fee_cents || ' net ' || net_cents
  from shop.fittings_settlements where order_id = '00000000-0000-4000-8000-0000000000f1') = 'routed parts 1000 ship 1200 cut 100 fee 59 net 2041',
  'the dealer''s line: parts, all the shipping, 10% cut, the card fee, and what they''re owed');
select pg_temp.check(not exists (select 1 from shop.fittings_settlements where order_id = '00000000-0000-4000-8000-0000000000f2'),
  'nothing is owed when Backroad Iron ships its own');

-- Pickups stay at the counter they were bought from.
select pg_temp.new_order('00000000-0000-4000-8000-0000000000f3', 'a', 1, 'pickup', null::uuid, false);
select pg_temp.check(pg_temp.pay('00000000-0000-4000-8000-0000000000f3', '61951', 'IL', 59) and pg_temp.from_('00000000-0000-4000-8000-0000000000f3') = 'MAINx1',
  'a Backroad Iron pickup stays at Backroad Iron''s counter, however near the dealer is');

-- Split: 6 wanted; MAIN 3, MCD 3 left. Customer near MCD: MCD first.
select pg_temp.new_order('00000000-0000-4000-8000-0000000000f4', 'a', 6, 'parcel', null::uuid, false);
select pg_temp.check(pg_temp.pay('00000000-0000-4000-8000-0000000000f4', '61951', 'IL', 200), 'a big order is paid');
select pg_temp.check(pg_temp.from_('00000000-0000-4000-8000-0000000000f4') = 'MAINx3,MCDx3', 'when no one place has it all, both ship');
select pg_temp.check((select shipping_cents from shop.fittings_settlements where order_id = '00000000-0000-4000-8000-0000000000f4') = 600,
  'the dealer gets its share of the shipping');
select pg_temp.check((select string_agg(o.kind || o.delta, ',' order by o.id) from shop.fittings_stock_moves o
  join shop.fittings_locations l on l.id = o.location_id where o.order_id = '00000000-0000-4000-8000-0000000000f4') = 'sale-3,sale-3', 'nearest first');

-- McCormick's own store.
update shop.fittings_onhand set qty = 2 where product_id = 'a' and location_id = pg_temp.loc('MCD');
select pg_temp.new_order('00000000-0000-4000-8000-0000000000f5', 'b', 1, 'parcel', pg_temp.dealer('mccormick-diesel'), true);
select pg_temp.check(pg_temp.pay('00000000-0000-4000-8000-0000000000f5', '62565', 'IL', null), 'an order from McCormick''s own store is paid, fee not known yet');
select pg_temp.check((select kind || ' cut ' || cut_cents || ' fee ' || coalesce(card_fee_cents::text, 'none') || ' net ' || coalesce(net_cents::text, 'none')
  from shop.fittings_settlements where order_id = '00000000-0000-4000-8000-0000000000f5') = 'storefront cut 0 fee none net none',
  'their own sale is theirs, no routing cut, net waits for the fee');
select shop.fittings_record_card_fee('00000000-0000-4000-8000-0000000000f5', 66);
select pg_temp.check((select card_fee_cents || ' ' || net_cents from shop.fittings_settlements where order_id = '00000000-0000-4000-8000-0000000000f5') = '66 2134',
  'when the fee arrives, the net is filled in');

-- Routing off: Backroad Iron orders stay home even near a dealer.
update shop.fittings_settings set route_orders = false where id = 1;
update shop.fittings_onhand set qty = 3 where product_id = 'a' and location_id = pg_temp.loc('MAIN');
select pg_temp.new_order('00000000-0000-4000-8000-0000000000f6', 'a', 1, 'parcel', null::uuid, false);
select pg_temp.check(pg_temp.pay('00000000-0000-4000-8000-0000000000f6', '61951', 'IL', 59) and pg_temp.from_('00000000-0000-4000-8000-0000000000f6') = 'MAINx1',
  'with routing off, Backroad Iron orders ship from Backroad Iron');

-- Holds respect the pool.
update shop.fittings_onhand set qty = 0 where product_id = 'a' and location_id = pg_temp.loc('MAIN');
select pg_temp.new_order('00000000-0000-4000-8000-0000000000f7', 'a', 1, 'parcel', null::uuid, false);
select pg_temp.check((shop.fittings_hold_order('00000000-0000-4000-8000-0000000000f7', 30)->>'ok') = 'false',
  'Backroad Iron''s store can''t hold a dealer''s part while routing is off');

-- The ledger can't be rewritten.
do $$ begin
  update shop.fittings_settlements set cut_cents = 0 where order_id = '00000000-0000-4000-8000-0000000000f1';
  raise exception 'FAILED: a ledger amount changed';
exception when raise_exception then if sqlerrm like 'FAILED%' then raise; end if; raise notice 'pass: ledger amounts can''t be changed';
end $$;
update shop.fittings_settlements set paid_at = now(), paid_note = 'Check 1041' where order_id = '00000000-0000-4000-8000-0000000000f1';
do $$ begin
  update shop.fittings_settlements set paid_note = 'oops' where order_id = '00000000-0000-4000-8000-0000000000f1';
  raise exception 'FAILED: a paid row changed';
exception when raise_exception then if sqlerrm like 'FAILED%' then raise; end if; raise notice 'pass: a paid row stays paid';
end $$;
do $$ begin
  delete from shop.fittings_settlements;
  raise exception 'FAILED: ledger rows deleted';
exception when raise_exception then if sqlerrm like 'FAILED%' then raise; end if; raise notice 'pass: ledger rows are kept';
end $$;
select pg_temp.check(not has_table_privilege('anon', 'shop.fittings_settlements', 'select'), 'shoppers can''t see the ledger');

rollback;
select 'all passed';
