-- Checks for add-locations.sql, on a scratch database with schema.sql,
-- add-stock-holds.sql and add-locations.sql loaded, and items a (3) and b (1):
--   psql -v ON_ERROR_STOP=1 -d <scratch> -f supabase/test-locations.sql
begin;

create or replace function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if not coalesce(ok, false) then raise exception 'FAILED: %', what; end if;
  raise notice 'pass: %', what;
end $$;
create or replace function pg_temp.at(text, text) returns integer language sql as $$
  select coalesce((select o.qty from shop.fittings_onhand o join shop.fittings_locations l on l.id = o.location_id
                   where o.product_id = $1 and l.code = $2), 0);
$$;
create or replace function pg_temp.total(text) returns integer language sql as $$
  select qty from shop.fittings_products where id = $1;
$$;
create or replace function pg_temp.loc(text) returns uuid language sql as $$
  select id from shop.fittings_locations where kind = 'store' and code = $1 limit 1;
$$;
create or replace function pg_temp.consistent() returns boolean language sql as $$
  select not exists (select 1 from shop.fittings_products p
    where p.qty <> coalesce((select sum(qty) from shop.fittings_onhand o where o.product_id = p.id), 0));
$$;

select pg_temp.check(pg_temp.at('a', 'MAIN') = 3 and pg_temp.at('b', 'MAIN') = 1, 'today''s stock is at the main shop');
select pg_temp.check(pg_temp.consistent(), 'every total equals its locations');

insert into shop.fittings_locations (name, kind, dealer_id, code, sort)
select 'Effingham', 'store', id, 'EFF', 1 from shop.fittings_dealers where slug = 'backroad-iron';

select shop.fittings_adjust_qty('a', 4, 'receive', 'Burns PO 1', pg_temp.loc('EFF'));
select pg_temp.check(pg_temp.at('a', 'EFF') = 4 and pg_temp.total('a') = 7, 'a shipment received at Effingham adds there and to the total');
select pg_temp.check((select kind || ':' || delta || ':' || qty_after || ':' || note from shop.fittings_stock_moves
  where product_id = 'a' and location_id = pg_temp.loc('EFF') order by id desc limit 1) = 'receive:4:4:Burns PO 1', 'the history line names the location');

update shop.fittings_products set qty = qty + 2 where id = 'a';
select pg_temp.check(pg_temp.at('a', 'MAIN') = 5 and pg_temp.total('a') = 9, 'a direct change to the total goes to the default location');
update shop.fittings_products set qty = qty - 6 where id = 'a';
select pg_temp.check(pg_temp.at('a', 'MAIN') = 0 and pg_temp.at('a', 'EFF') = 3 and pg_temp.total('a') = 3, 'a direct cut takes from the default first, then elsewhere');
update shop.fittings_products set qty = 0 where id = 'z';
update shop.fittings_products set qty = qty - 5 where id = 'b';
select pg_temp.check(pg_temp.total('b') = 0 and pg_temp.consistent(), 'a cut below zero stops at zero');

select shop.fittings_transfer('a', pg_temp.loc('EFF'), pg_temp.loc('MAIN'), 2, 'for the counter');
select pg_temp.check(pg_temp.at('a', 'EFF') = 1 and pg_temp.at('a', 'MAIN') = 2 and pg_temp.total('a') = 3, 'a transfer moves parts and keeps the total');
select pg_temp.check((select count(*) from shop.fittings_stock_moves where product_id = 'a' and kind = 'transfer') = 2, 'a transfer writes a line at each end');
do $$ begin
  perform shop.fittings_transfer('a', pg_temp.loc('EFF'), pg_temp.loc('MAIN'), 5, '');
  raise exception 'FAILED: moved more than was there';
exception when raise_exception then
  if sqlerrm like 'FAILED%' then raise; end if;
  raise notice 'pass: can''t move more than is there (%)', sqlerrm;
end $$;

select shop.fittings_count_qty('b', 2, 'recount', pg_temp.loc('EFF'));
select shop.fittings_count_qty('b', 1, '', null);
select pg_temp.check(pg_temp.at('b', 'EFF') = 2 and pg_temp.at('b', 'MAIN') = 1 and pg_temp.total('b') = 3, 'recounts at a location, or at the default when none is named');

insert into shop.fittings_products (id, name, qty, price_cents) values ('n', 'New', 5, 100);
select pg_temp.check(pg_temp.at('n', 'MAIN') = 5 and pg_temp.total('n') = 5, 'a new item''s count starts at the default location');
select pg_temp.check((select kind from shop.fittings_stock_moves where product_id = 'n' order by id desc limit 1) = 'start', 'and is logged as its start');

do $$ begin
  insert into shop.fittings_onhand (product_id, location_id, qty)
  select 'a', id, 1 from shop.fittings_locations where kind = 'survey' limit 1;
  if not found then
    insert into shop.fittings_locations (name, kind) values ('Survey only', 'survey');
    insert into shop.fittings_onhand (product_id, location_id, qty)
    select 'a', id, 1 from shop.fittings_locations where name = 'Survey only';
  end if;
  raise exception 'FAILED: stock kept at a survey location';
exception when raise_exception then
  if sqlerrm like 'FAILED%' then raise; end if;
  raise notice 'pass: stock is only kept at store locations';
end $$;

-- Paying. Now: a MAIN 2 EFF 1 · b MAIN 1 EFF 2.
insert into shop.fittings_orders (id, status, ship_method) values
  ('00000000-0000-4000-8000-0000000000c1', 'pending', 'parcel'),
  ('00000000-0000-4000-8000-0000000000c2', 'pending', 'parcel'),
  ('00000000-0000-4000-8000-0000000000c3', 'pending', 'pickup'),
  ('00000000-0000-4000-8000-0000000000c4', 'pending', 'parcel');
insert into shop.fittings_order_items (order_id, product_id, name, unit_price_cents, qty) values
  ('00000000-0000-4000-8000-0000000000c1', 'b', 'Tee', 200, 2),
  ('00000000-0000-4000-8000-0000000000c1', 'a', 'Cap', 100, 1),
  ('00000000-0000-4000-8000-0000000000c2', 'a', 'Cap', 100, 2),
  ('00000000-0000-4000-8000-0000000000c3', 'n', 'New', 100, 1),
  ('00000000-0000-4000-8000-0000000000c4', 'n', 'New', 100, 9);

select pg_temp.check((shop.fittings_hold_order('00000000-0000-4000-8000-0000000000c1', 30)->>'ok')::boolean, 'holds still work on the total');
select pg_temp.check(shop.fittings_fulfill_order('00000000-0000-4000-8000-0000000000c1', '{}'), 'order 1 is paid');
select pg_temp.check((select string_agg(a.product_id || '@' || l.code || 'x' || a.qty, ',' order by a.product_id)
  from shop.fittings_allocations a join shop.fittings_locations l on l.id = a.location_id
  where a.order_id = '00000000-0000-4000-8000-0000000000c1') = 'a@EFFx1,b@EFFx2', 'it ships whole from Effingham, the one place that has it all');
select pg_temp.check(pg_temp.at('a', 'EFF') = 0 and pg_temp.at('b', 'EFF') = 0 and pg_temp.total('a') = 2 and pg_temp.total('b') = 1, 'Effingham''s counts and the totals come down');
select pg_temp.check((select count(*) from shop.fittings_stock_moves where order_id = '00000000-0000-4000-8000-0000000000c1' and kind = 'sale' and location_id = pg_temp.loc('EFF')) = 2, 'each sale line names the order and location');
select pg_temp.check((select count(*) from shop.fittings_holds where order_id = '00000000-0000-4000-8000-0000000000c1' and end_reason = 'sold') = 2, 'its holds end as sold');

-- Split: a MAIN 2 EFF 0; give EFF one so two are needed from MAIN... order 2 wants 2 a: MAIN has 2.
select shop.fittings_adjust_qty('a', 1, 'receive', '', pg_temp.loc('EFF'));
update shop.fittings_onhand set qty = 1 where product_id = 'a' and location_id = pg_temp.loc('MAIN');
select pg_temp.check(shop.fittings_fulfill_order('00000000-0000-4000-8000-0000000000c2', '{}'), 'order 2 is paid');
select pg_temp.check((select string_agg(l.code || 'x' || a.qty, ',' order by l.sort)
  from shop.fittings_allocations a join shop.fittings_locations l on l.id = a.location_id
  where a.order_id = '00000000-0000-4000-8000-0000000000c2') = 'MAINx1,EFFx1', 'when no one place has it all, it comes from both, the default first');
select pg_temp.check(not (select stock_short from shop.fittings_orders where id = '00000000-0000-4000-8000-0000000000c2'), 'a split order is not short');

-- Pickup: Effingham doesn't do pickup; MAIN has n.
select shop.fittings_adjust_qty('n', 3, 'receive', '', pg_temp.loc('EFF'));
update shop.fittings_locations set pickup = false where code = 'EFF';
update shop.fittings_settings set default_location_id = pg_temp.loc('EFF') where id = 1;
select pg_temp.check(shop.fittings_fulfill_order('00000000-0000-4000-8000-0000000000c3', '{}'), 'pickup order is paid');
select pg_temp.check((select l.code from shop.fittings_allocations a join shop.fittings_locations l on l.id = a.location_id
  where a.order_id = '00000000-0000-4000-8000-0000000000c3') = 'MAIN', 'a pickup order goes to a location that does pickup, even over the default');

-- Short: wants 9, there are 4 + 3 - 1 = 7.
select pg_temp.check(shop.fittings_fulfill_order('00000000-0000-4000-8000-0000000000c4', '{}'), 'short order is paid');
select pg_temp.check((select stock_short from shop.fittings_orders where id = '00000000-0000-4000-8000-0000000000c4')
  and (select sum(qty) from shop.fittings_allocations where order_id = '00000000-0000-4000-8000-0000000000c4') = 7
  and pg_temp.total('n') = 0, 'a short order takes what there is and is flagged');
select pg_temp.check(not shop.fittings_fulfill_order('00000000-0000-4000-8000-0000000000c4', '{}'), 'paying twice does nothing');
select pg_temp.check(pg_temp.consistent(), 'every total still equals its locations');

select pg_temp.check(not has_table_privilege('anon', 'shop.fittings_onhand', 'select')
  and not has_table_privilege('anon', 'shop.fittings_allocations', 'select')
  and not has_function_privilege('anon', 'shop.fittings_transfer(text, uuid, uuid, integer, text)', 'execute'), 'shoppers can''t read or change location counts');

rollback;
select 'all passed';
