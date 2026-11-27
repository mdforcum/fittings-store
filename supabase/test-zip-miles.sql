-- Checks for add-zip-miles.sql (scratch database with every shop change
-- loaded, items a and b):
--   psql -v ON_ERROR_STOP=1 -d <scratch> -f supabase/test-zip-miles.sql
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

select pg_temp.check((select not route_orders and route_cut_bps = 600 and storefront_fee_bps = 0 and house_dealer_id = pg_temp.dealer('backroad-iron')
  from shop.fittings_settings where id = 1), 'routing starts off, with a 6% selling share and Backroad Iron as the house');

-- Main shop in Shelbyville; McCormick's shop in Sullivan.
update shop.fittings_locations set zip = '62565', state = 'IL', city = 'Shelbyville' where code = 'MAIN';

insert into shop.fittings_dealers (name, slug) values ('Paris Parts', 'paris-parts'), ('Evansville Equipment', 'evansville-eq');
update shop.fittings_locations set zip = '62565', state = 'IL' where code = 'MAIN';
insert into shop.fittings_locations (name, kind, dealer_id, code, state, zip, takes_routed) values
  ('Paris shop', 'store', pg_temp.dealer('paris-parts'), 'PAR', 'IL', '61944', true),
  ('Evansville shop', 'store', pg_temp.dealer('evansville-eq'), 'EVV', 'IN', '47708', true);
update shop.fittings_settings set route_orders = true where id = 1;
delete from shop.fittings_onhand where product_id in ('a', 'b');
insert into shop.fittings_onhand (product_id, location_id, qty) values ('a', pg_temp.loc('PAR'), 2), ('a', pg_temp.loc('EVV'), 2);

-- A shopper in Terre Haute, Indiana: Paris, Illinois is about 20 miles away; Evansville, Indiana about 100.
select pg_temp.check(shop.fittings_miles('62565', '61951') is null, 'no distance until the ZIP table is filled');
select pg_temp.check(shop.fittings_nearness(pg_temp.loc('EVV'), '47802', 'IN') = 1 and shop.fittings_nearness(pg_temp.loc('PAR'), '47802', 'IN') = 0,
  'with no ZIP table, the old rule holds: same state wins');
select pg_temp.new_order('00000000-0000-4000-8000-0000000000e1', 'a', 1, 'parcel', null::uuid, false);
select pg_temp.check(pg_temp.pay('00000000-0000-4000-8000-0000000000e1', '47802', 'IN', 0), 'order paid under the old rule');
select pg_temp.check(pg_temp.from_('00000000-0000-4000-8000-0000000000e1') = 'EVVx1', 'the old rule sends it to the same-state shop 100 miles away');

insert into shop.fittings_zip_points (zip, lat, lng) values
  ('62565', 39.458, -88.8058), ('61951', 39.5953, -88.6069), ('61944', 39.6112, -87.6961), ('47708', 37.9716, -87.5711), ('47802', 39.4067, -87.4020);
select pg_temp.check(shop.fittings_miles('62565', '61951') between 12 and 16, 'Shelbyville to Sullivan is about 14 miles');
select pg_temp.check(shop.fittings_miles('62565', '62565') = 0 and shop.fittings_miles('62565-1234', '61951') between 12 and 16, 'same ZIP is zero; ZIP+4 works');
select pg_temp.check(shop.fittings_miles('47802', '61944') < 25 and shop.fittings_miles('47802', '47708') > 90, 'Paris is close to Terre Haute; Evansville is not');
select pg_temp.check(shop.fittings_miles('62565', '00000') is null and shop.fittings_miles(null, '62565') is null, 'an unknown ZIP gives no distance');
select pg_temp.check(shop.fittings_nearness(pg_temp.loc('PAR'), '47802', 'IN') > shop.fittings_nearness(pg_temp.loc('EVV'), '47802', 'IN'),
  'with miles known, the nearer shop ranks first even across a state line');
select pg_temp.check(shop.fittings_nearness(pg_temp.loc('PAR'), '99999', 'IL') = 1 and shop.fittings_nearness(pg_temp.loc('PAR'), '61999', 'IL') = 2,
  'a shopper ZIP that isn''t in the table falls back to the old rule');
select pg_temp.check(shop.fittings_nearness(pg_temp.loc('PAR'), '47802', 'IN') > 999900, 'any measured distance outranks the old rule');

select pg_temp.new_order('00000000-0000-4000-8000-0000000000e2', 'a', 1, 'parcel', null::uuid, false);
select pg_temp.check(pg_temp.pay('00000000-0000-4000-8000-0000000000e2', '47802', 'IN', 0), 'order paid with miles known');
select pg_temp.check(pg_temp.from_('00000000-0000-4000-8000-0000000000e2') = 'PARx1', 'now it goes to the shop 20 miles away');
select pg_temp.check(not has_table_privilege('anon', 'shop.fittings_zip_points', 'select') and not has_function_privilege('anon', 'shop.fittings_miles(text, text)', 'execute'),
  'shoppers can''t read the ZIP table or the distance function');

rollback;
select 'all passed';
