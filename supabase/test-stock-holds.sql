-- Checks for add-stock-holds.sql. Run against a scratch database that has
-- schema.sql loaded (see the header of this file's commit for the recipe):
--   psql -v ON_ERROR_STOP=1 -d <scratch> -f supabase/test-stock-holds.sql
-- Every check raises if it fails; the script ends by printing "all passed".
begin;

create or replace function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if not coalesce(ok, false) then raise exception 'FAILED: %', what; end if;
  raise notice 'pass: %', what;
end $$;

delete from shop.fittings_order_items; delete from shop.fittings_orders;
insert into shop.fittings_products (id, name, qty, price_cents) values ('t-cap', 'Cap', 3, 100), ('t-tee', 'Tee', 1, 200)
  on conflict (id) do update set qty = excluded.qty;

-- Two shoppers want the only tee.
insert into shop.fittings_orders (id, status) values
  ('00000000-0000-4000-8000-000000000001', 'pending'),
  ('00000000-0000-4000-8000-000000000002', 'pending'),
  ('00000000-0000-4000-8000-000000000003', 'pending');
insert into shop.fittings_order_items (order_id, product_id, name, unit_price_cents, qty) values
  ('00000000-0000-4000-8000-000000000001', 't-tee', 'Tee', 200, 1),
  ('00000000-0000-4000-8000-000000000001', 't-cap', 'Cap', 100, 2),
  ('00000000-0000-4000-8000-000000000002', 't-tee', 'Tee', 200, 1),
  ('00000000-0000-4000-8000-000000000003', 't-cap', 'Cap', 100, 1);

select pg_temp.check((shop.fittings_hold_order('00000000-0000-4000-8000-000000000001', 30)->>'ok')::boolean, 'first checkout holds its parts');
select pg_temp.check((select held from shop.fittings_held() where product_id = 't-tee') = 1, 'the held tee is counted');
select pg_temp.check(shop.fittings_hold_order('00000000-0000-4000-8000-000000000002', 30)
  = '{"ok": false, "problems": [{"id": "t-tee", "available": 0}]}'::jsonb, 'second checkout is told the tee is gone');
select pg_temp.check((select count(*) from shop.fittings_holds where order_id = '00000000-0000-4000-8000-000000000002') = 0, 'a refused checkout holds nothing');
select pg_temp.check((shop.fittings_hold_order('00000000-0000-4000-8000-000000000003', 30)->>'ok')::boolean, 'the last cap can still be held');
select pg_temp.check((shop.fittings_hold_order('00000000-0000-4000-8000-000000000003', 30)->>'ok')::boolean
  and (select count(*) from shop.fittings_holds where order_id = '00000000-0000-4000-8000-000000000003' and ended_at is null) = 1,
  'holding again for one order restarts its hold instead of stacking');
select shop.fittings_release_holds('00000000-0000-4000-8000-000000000003', 'released');

-- The first shopper pays.
select pg_temp.check(shop.fittings_fulfill_order('00000000-0000-4000-8000-000000000001', '{}'::jsonb), 'payment goes through');
select pg_temp.check((select qty from shop.fittings_products where id = 't-tee') = 0 and (select qty from shop.fittings_products where id = 't-cap') = 1, 'paid parts come off the shelf count');
select pg_temp.check((select count(*) from shop.fittings_holds where order_id = '00000000-0000-4000-8000-000000000001' and end_reason = 'sold') = 2, 'its holds end as sold');
select pg_temp.check((select count(*) from shop.fittings_stock_moves where order_id = '00000000-0000-4000-8000-000000000001' and kind = 'sale') = 2, 'each sale is in the history with the order');
select pg_temp.check(not shop.fittings_fulfill_order('00000000-0000-4000-8000-000000000001', '{}'::jsonb), 'paying twice does nothing');
select pg_temp.check(not exists (select 1 from shop.fittings_held()), 'nothing is held after the sale');

-- A hold that runs out stops counting.
update shop.fittings_products set qty = 5 where id = 't-tee';
select pg_temp.check((select kind from shop.fittings_stock_moves where product_id = 't-tee' order by id desc limit 1) = 'edit', 'a direct edit is in the history');
select pg_temp.check((shop.fittings_hold_order('00000000-0000-4000-8000-000000000002', 30)->>'ok')::boolean, 'restocked tee can be held');
alter table shop.fittings_holds disable trigger fittings_holds_guard;
update shop.fittings_holds set expires_at = now() - interval '1 minute' where order_id = '00000000-0000-4000-8000-000000000002';
alter table shop.fittings_holds enable trigger fittings_holds_guard;
select pg_temp.check(not exists (select 1 from shop.fittings_held()), 'an expired hold is not counted');

-- Received stock, with a reason.
select pg_temp.check(shop.fittings_adjust_qty('t-cap', 10, 'receive', 'Burns order 4471') = 11, 'receiving adds to the count');
select pg_temp.check((select kind || ':' || delta || ':' || note from shop.fittings_stock_moves where product_id = 't-cap' order by id desc limit 1) = 'receive:10:Burns order 4471', 'the receipt is in the history');
select pg_temp.check(shop.fittings_adjust_qty('t-cap', -1) = 10, 'two-argument adjust still works');

select pg_temp.check(shop.fittings_count_qty('t-cap', 7, 'Shelf recount') = 7, 'a recount sets the count');
select pg_temp.check((select kind || ':' || delta from shop.fittings_stock_moves where product_id = 't-cap' order by id desc limit 1) = 'count:-3',
  'a recount logs the difference');

-- History and holds cannot be rewritten.
do $$ begin
  begin update shop.fittings_stock_moves set delta = 99; raise exception 'FAILED: history was edited';
  exception when raise_exception then if sqlerrm like 'FAILED%' then raise; end if; end;
  begin delete from shop.fittings_stock_moves; raise exception 'FAILED: history was deleted';
  exception when raise_exception then if sqlerrm like 'FAILED%' then raise; end if; end;
  begin update shop.fittings_holds set end_reason = 'released' where end_reason = 'sold'; raise exception 'FAILED: ended hold changed';
  exception when raise_exception then if sqlerrm like 'FAILED%' then raise; end if; end;
  begin update shop.fittings_holds set qty = 9 where ended_at is null; raise exception 'FAILED: hold size changed';
  exception when raise_exception then if sqlerrm like 'FAILED%' then raise; end if; end;
  raise notice 'pass: history and holds cannot be rewritten';
end $$;

-- Shoppers see totals only.
select pg_temp.check(has_function_privilege('anon', 'shop.fittings_held()', 'execute'), 'shoppers can read what is held');
select pg_temp.check(not has_table_privilege('anon', 'shop.fittings_holds', 'select'), 'shoppers cannot read the holds themselves');
select pg_temp.check(not has_function_privilege('anon', 'shop.fittings_hold_order(uuid, integer)', 'execute'), 'shoppers cannot place holds directly');

rollback;
select 'all passed';
