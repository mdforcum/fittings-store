-- Checks for add-storefronts.sql, on a scratch database with schema.sql and
-- the stock-holds, locations, storefronts and storefront-options changes loaded
-- (these orders come from a store that shows only its own stock):
--   psql -v ON_ERROR_STOP=1 -d <scratch> -f supabase/test-storefronts.sql
begin;

create or replace function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if not coalesce(ok, false) then raise exception 'FAILED: %', what; end if;
  raise notice 'pass: %', what;
end $$;
create or replace function pg_temp.dealer(text) returns uuid language sql as $$ select id from shop.fittings_dealers where slug = $1 $$;
create or replace function pg_temp.loc(text) returns uuid language sql as $$ select id from shop.fittings_locations where kind = 'store' and code = $1 $$;

select pg_temp.check((select host from shop.fittings_storefronts where slug = 'mccormick-diesel') = 'parts.mccormickdiesel.com'
  and not (select live from shop.fittings_storefronts where slug = 'mccormick-diesel'), 'McCormick''s storefront is set up, not live yet');

-- McCormick gets a shop with some caps; Backroad Iron's main shop has caps too.
insert into shop.fittings_locations (name, kind, dealer_id, code) values ('McCormick shop', 'store', pg_temp.dealer('mccormick-diesel'), 'MCD');
delete from shop.fittings_onhand where product_id in ('a', 'b');
insert into shop.fittings_onhand (product_id, location_id, qty) values ('a', pg_temp.loc('MAIN'), 5), ('a', pg_temp.loc('MCD'), 2);
select pg_temp.check((select qty from shop.fittings_products where id = 'a') = 7, 'the total counts both dealers');
select pg_temp.check((select qty from shop.fittings_dealer_stock(pg_temp.dealer('mccormick-diesel')) where product_id = 'a') = 2
  and not exists (select 1 from shop.fittings_dealer_stock(pg_temp.dealer('mccormick-diesel')) where product_id = 'b'),
  'McCormick''s store shows only what is on its own shelf');

insert into shop.fittings_orders (id, status, ship_method, dealer_id, own_stock_only) values
  ('00000000-0000-4000-8000-0000000000d1', 'pending', 'parcel', pg_temp.dealer('mccormick-diesel'), true),
  ('00000000-0000-4000-8000-0000000000d2', 'pending', 'parcel', pg_temp.dealer('mccormick-diesel'), true),
  ('00000000-0000-4000-8000-0000000000d3', 'pending', 'parcel', null, false);
insert into shop.fittings_order_items (order_id, product_id, name, unit_price_cents, qty) values
  ('00000000-0000-4000-8000-0000000000d1', 'a', 'Cap', 100, 2),
  ('00000000-0000-4000-8000-0000000000d2', 'a', 'Cap', 100, 1),
  ('00000000-0000-4000-8000-0000000000d3', 'a', 'Cap', 100, 5);

select pg_temp.check((shop.fittings_hold_order('00000000-0000-4000-8000-0000000000d1', 30)->>'ok')::boolean, 'a McCormick shopper holds their 2 caps');
select pg_temp.check((select qty from shop.fittings_dealer_stock(pg_temp.dealer('mccormick-diesel')) where product_id = 'a') = 0, 'McCormick''s store then shows none left');
select pg_temp.check(shop.fittings_hold_order('00000000-0000-4000-8000-0000000000d2', 30)
  = '{"ok": false, "problems": [{"id": "a", "available": 0}]}'::jsonb, 'a second McCormick shopper is told they''re gone, though Backroad Iron has 5');
select pg_temp.check((shop.fittings_hold_order('00000000-0000-4000-8000-0000000000d3', 30)->>'ok')::boolean, 'the Backroad Iron store can still sell its own 5');

select pg_temp.check(shop.fittings_fulfill_order('00000000-0000-4000-8000-0000000000d1', '{}'), 'the McCormick order is paid');
select pg_temp.check((select string_agg(l.code || 'x' || a.qty, ',') from shop.fittings_allocations a join shop.fittings_locations l on l.id = a.location_id
  where a.order_id = '00000000-0000-4000-8000-0000000000d1') = 'MCDx2', 'it is filled from McCormick''s shelf, not the default location');

-- A McCormick order that its shelf can't cover comes up short rather than borrowing Backroad Iron's stock.
update shop.fittings_orders set status = 'pending' where id = '00000000-0000-4000-8000-0000000000d2';
select pg_temp.check(shop.fittings_fulfill_order('00000000-0000-4000-8000-0000000000d2', '{}'), 'a late McCormick payment goes through');
select pg_temp.check((select stock_short from shop.fittings_orders where id = '00000000-0000-4000-8000-0000000000d2')
  and not exists (select 1 from shop.fittings_allocations where order_id = '00000000-0000-4000-8000-0000000000d2'),
  'and is flagged short instead of taking another dealer''s parts');
select pg_temp.check(shop.fittings_fulfill_order('00000000-0000-4000-8000-0000000000d3', '{}'), 'the Backroad Iron order is paid');
select pg_temp.check((select l.code from shop.fittings_allocations a join shop.fittings_locations l on l.id = a.location_id
       where a.order_id = '00000000-0000-4000-8000-0000000000d3') = 'MAIN', 'a Backroad Iron order fills from the main shop as before');

select pg_temp.check(not has_table_privilege('anon', 'shop.fittings_storefronts', 'select'), 'shoppers can''t read storefront settings directly');
select pg_temp.check(has_function_privilege('anon', 'shop.fittings_dealer_stock(uuid)', 'execute'), 'shoppers can read a dealer''s counts');

do $$ begin
  insert into shop.fittings_storefronts (slug, host, name) values ('bad', 'Parts.Example.com', 'Bad');
  raise exception 'FAILED: a mixed-case address was saved';
exception when check_violation then raise notice 'pass: addresses are stored in lower case';
end $$;

rollback;
select 'all passed';
