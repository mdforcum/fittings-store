-- Checks for add-storefront-options.sql (scratch database with every shop
-- change loaded, items a and b):
--   psql -v ON_ERROR_STOP=1 -d <scratch> -f supabase/test-storefront-options.sql
begin;

create or replace function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if not coalesce(ok, false) then raise exception 'FAILED: %', what; end if;
  raise notice 'pass: %', what;
end $$;
create or replace function pg_temp.dealer(text) returns uuid language sql as $$ select id from shop.fittings_dealers where slug = $1 $$;
create or replace function pg_temp.loc(text) returns uuid language sql as $$ select id from shop.fittings_locations where kind = 'store' and code = $1 $$;

select pg_temp.check((select stock_scope = 'own' and not location_filter and not ship_own from shop.fittings_storefronts where slug = 'mccormick-diesel'),
  'stores start with their own stock, no location filter and Backroad Iron''s shipping');
select pg_temp.check(not (select location_filter from shop.fittings_settings where id = 1), 'the Backroad Iron store starts without a location filter');

insert into shop.fittings_locations (name, kind, dealer_id, code, city, state) values ('McCormick shop', 'store', pg_temp.dealer('mccormick-diesel'), 'MCD', 'Sullivan', 'IL');
insert into shop.fittings_locations (name, kind, dealer_id, code, active) values ('Old barn', 'store', pg_temp.dealer('backroad-iron'), 'OLD', false);
delete from shop.fittings_onhand where product_id in ('a', 'b');
insert into shop.fittings_onhand (product_id, location_id, qty) values
  ('a', pg_temp.loc('MAIN'), 5), ('a', pg_temp.loc('MCD'), 1), ('b', pg_temp.loc('MAIN'), 2), ('b', pg_temp.loc('OLD'), 3), ('b', pg_temp.loc('MCD'), 0);

-- Location filter data.
select pg_temp.check((select string_agg(location_name || ':' || product_id || 'x' || qty, ',' order by location_name, product_id)
  from shop.fittings_location_stock(null)) = 'Main shop:ax5,Main shop:bx2,McCormick shop:ax1', 'every open location''s shelf, with empty and closed ones left out');
select pg_temp.check((select string_agg(location_name || ' ' || city || ' ' || dealer_name || ':' || product_id, ',')
  from shop.fittings_location_stock(pg_temp.dealer('mccormick-diesel'))) = 'McCormick shop Sullivan McCormick Diesel:a', 'one dealer''s locations only');
select pg_temp.check(has_function_privilege('anon', 'shop.fittings_location_stock(uuid)', 'execute'), 'shoppers can read shelf counts by location');

-- A McCormick store that shows every part on Backroad Iron. a: MAIN 5, MCD 1.
insert into shop.fittings_orders (id, status, ship_method, dealer_id, own_stock_only) values
  ('00000000-0000-4000-8000-0000000000e1', 'pending', 'parcel', pg_temp.dealer('mccormick-diesel'), false),
  ('00000000-0000-4000-8000-0000000000e2', 'pending', 'parcel', pg_temp.dealer('mccormick-diesel'), true),
  ('00000000-0000-4000-8000-0000000000e3', 'pending', 'parcel', pg_temp.dealer('mccormick-diesel'), false),
  ('00000000-0000-4000-8000-0000000000e4', 'pending', 'parcel', pg_temp.dealer('mccormick-diesel'), false);
insert into shop.fittings_order_items (order_id, product_id, name, unit_price_cents, qty) values
  ('00000000-0000-4000-8000-0000000000e1', 'a', 'Cap', 100, 2),
  ('00000000-0000-4000-8000-0000000000e2', 'a', 'Cap', 100, 2),
  ('00000000-0000-4000-8000-0000000000e3', 'a', 'Cap', 100, 1),
  ('00000000-0000-4000-8000-0000000000e4', 'a', 'Cap', 100, 3);
select pg_temp.check((shop.fittings_hold_order('00000000-0000-4000-8000-0000000000e1', 30)->>'ok')::boolean,
  'a network order can hold more than the dealer''s own shelf has');
select pg_temp.check((shop.fittings_hold_order('00000000-0000-4000-8000-0000000000e2', 30)->>'ok') = 'false',
  'an own-stock order can''t');
select pg_temp.check((select qty from shop.fittings_dealer_stock(pg_temp.dealer('mccormick-diesel')) where product_id = 'a') = 1,
  'a network hold doesn''t take from the dealer''s own-store count');

select pg_temp.check(shop.fittings_fulfill_order('00000000-0000-4000-8000-0000000000e3', '{}'), 'a one-cap network order is paid');
select pg_temp.check((select string_agg(l.code || 'x' || a.qty, ',') from shop.fittings_allocations a join shop.fittings_locations l on l.id = a.location_id
  where a.order_id = '00000000-0000-4000-8000-0000000000e3') = 'MCDx1', 'when the dealer''s own shelf has it all, it ships from there, ahead of the default');
select pg_temp.check(shop.fittings_fulfill_order('00000000-0000-4000-8000-0000000000e1', '{}'), 'a two-cap network order is paid');
select pg_temp.check((select string_agg(l.code || 'x' || a.qty, ',') from shop.fittings_allocations a join shop.fittings_locations l on l.id = a.location_id
  where a.order_id = '00000000-0000-4000-8000-0000000000e1') = 'MAINx2', 'when another location has it all, it ships whole from there');
update shop.fittings_onhand set qty = 1 where product_id = 'a' and location_id = pg_temp.loc('MCD');
-- MAIN 2, MCD 1: no one place has 3.
update shop.fittings_onhand set qty = 2 where product_id = 'a' and location_id = pg_temp.loc('MAIN');
select pg_temp.check(shop.fittings_fulfill_order('00000000-0000-4000-8000-0000000000e4', '{}'), 'a three-cap network order is paid');
select pg_temp.check((select string_agg(l.code || 'x' || a.qty, ',' order by l.code) from shop.fittings_allocations a join shop.fittings_locations l on l.id = a.location_id
  where a.order_id = '00000000-0000-4000-8000-0000000000e4') = 'MAINx2,MCDx1', 'when no one place has it all, it takes from the dealer''s shelf and the rest');
select pg_temp.check((select string_agg(o.kind || o.delta, ',' order by o.id) from shop.fittings_stock_moves o
  where o.order_id = '00000000-0000-4000-8000-0000000000e4') = 'sale-1,sale-2', 'the dealer''s own shelf is taken first');

select pg_temp.check(not (select own_stock_only from shop.fittings_orders where id = '00000000-0000-4000-8000-0000000000e1'), 'the order remembers it could use any shelf');

do $$ begin
  update shop.fittings_storefronts set stock_scope = 'everything' where slug = 'mccormick-diesel';
  raise exception 'FAILED: an unknown stock choice was saved';
exception when check_violation then raise notice 'pass: stock choice is own or network only';
end $$;
do $$ begin
  update shop.fittings_storefronts set ship_flat_cents = -1 where slug = 'mccormick-diesel';
  raise exception 'FAILED: negative shipping was saved';
exception when check_violation then raise notice 'pass: shipping can''t be negative';
end $$;

rollback;
select 'all passed';
