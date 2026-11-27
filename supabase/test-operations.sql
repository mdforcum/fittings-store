-- Checks for add-operations.sql (scratch database with every shop change
-- loaded, items a and b):
--   psql -v ON_ERROR_STOP=1 -d <scratch> -f supabase/test-operations.sql
begin;

create or replace function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if not coalesce(ok, false) then raise exception 'FAILED: %', what; end if;
  raise notice 'pass: %', what;
end $$;
create or replace function pg_temp.fails(stmt text, what text) returns void language plpgsql as $$
begin
  begin
    execute stmt;
  exception when others then
    raise notice 'pass: % (%)', what, sqlerrm;
    return;
  end;
  raise exception 'FAILED: % (it went through)', what;
end $$;
create or replace function pg_temp.dealer(text) returns uuid language sql as $$ select id from shop.fittings_dealers where slug = $1 $$;
create or replace function pg_temp.loc(text) returns uuid language sql as $$ select id from shop.fittings_locations where kind = 'store' and code = $1 $$;
create or replace function pg_temp.new_order(uuid, uuid) returns void language sql as $$
  insert into shop.fittings_orders (id, status, ship_method, dealer_id, own_stock_only) values ($1, 'pending', 'parcel', $2, false);
$$;
create or replace function pg_temp.line(uuid, text, int) returns void language sql as $$
  insert into shop.fittings_order_items (order_id, product_id, name, unit_price_cents, qty) values ($1, $2, 'Part', 1000, $3);
$$;
create or replace function pg_temp.pay(uuid) returns boolean language sql as $$
  select shop.fittings_fulfill_order($1, jsonb_build_object('ship_to', jsonb_build_object('zip', '62565', 'state', 'IL'), 'shipping_cents', 0,
    'subtotal_cents', (select sum(unit_price_cents * qty) from shop.fittings_order_items where order_id = $1), 'card_fee_cents', 0));
$$;
create or replace function pg_temp.onhand(text, text) returns int language sql as $$
  select coalesce((select qty from shop.fittings_onhand where product_id = $1 and location_id = pg_temp.loc($2)), 0)
$$;
-- dealer slug: kind parts pays earns net (reversals included)
create or replace function pg_temp.lines(uuid) returns text language sql as $$
  select string_agg(d.slug || ': ' || s.kind || ' parts ' || s.parts_cents || ' ship ' || s.shipping_cents || ' pays ' || s.cut_cents || '+' || s.network_cents
                    || ' earns ' || s.referral_cents || ' net ' || coalesce(s.net_cents::text, '?'), '; ' order by d.slug, s.id)
  from shop.fittings_settlements s join shop.fittings_dealers d on d.id = s.dealer_id where s.order_id = $1;
$$;
create or replace function pg_temp.balance(uuid, text) returns int language sql as $$
  select coalesce(sum(net_cents), 0)::int from shop.fittings_settlements where order_id = $1 and dealer_id = pg_temp.dealer($2)
$$;

insert into shop.fittings_dealers (name, slug) values ('Arthur Ag', 'arthur-ag');
update shop.fittings_locations set zip = '62565', state = 'IL', street1 = '1 Main St', phone = '217-555-0100' where code = 'MAIN';
insert into shop.fittings_locations (name, kind, dealer_id, code, state, zip, takes_routed) values
  ('McCormick shop', 'store', pg_temp.dealer('mccormick-diesel'), 'MCD', 'IL', '61951', true),
  ('Arthur yard', 'store', pg_temp.dealer('arthur-ag'), 'ART', 'IL', '61911', true);
update shop.fittings_settings set route_orders = true where id = 1;
delete from shop.fittings_onhand where product_id in ('a', 'b');

select pg_temp.check((select street1 = '1 Main St' and street2 = '' and phone = '217-555-0100' from shop.fittings_locations where code = 'MAIN'),
  'a location keeps its own ship-from street and phone');

-- The ledger writer still works with the new key ------------------------------------
insert into shop.fittings_onhand (product_id, location_id, qty) values ('a', pg_temp.loc('MCD'), 2);
select pg_temp.new_order('00000000-0000-4000-8000-0000000000b1', null::uuid);
select pg_temp.line('00000000-0000-4000-8000-0000000000b1', 'a', 2);
select pg_temp.check(pg_temp.pay('00000000-0000-4000-8000-0000000000b1'), 'routed order paid');
select pg_temp.check(pg_temp.lines('00000000-0000-4000-8000-0000000000b1') = 'mccormick-diesel: routed parts 2000 ship 0 pays 120+0 earns 0 net 1880',
  'paying still writes the dealer''s line');
select pg_temp.check(pg_temp.onhand('a', 'MCD') = 0, 'both parts came off McCormick''s shelf');

-- Shipments ---------------------------------------------------------------------------
select pg_temp.fails($q$select shop.fittings_ship_from_location('00000000-0000-4000-8000-0000000000b1', pg_temp.loc('ART'), 'UPS', '1Z', '', 'x')$q$,
  'a location with nothing on the order can''t ship it');
select pg_temp.check(shop.fittings_ship_from_location('00000000-0000-4000-8000-0000000000b1', pg_temp.loc('MCD'), 'UPS', '1Z999', 'https://t', 'Dale'),
  'McCormick ships the whole order');
select pg_temp.check((select status = 'shipped' and tracking_number = '1Z999' and carrier = 'UPS' from shop.fittings_orders where id = '00000000-0000-4000-8000-0000000000b1'),
  'the order is shipped, with McCormick''s tracking');

-- Two locations on one order: shipped only after both ship.
insert into shop.fittings_onhand (product_id, location_id, qty) values ('a', pg_temp.loc('MAIN'), 1), ('b', pg_temp.loc('ART'), 1);
select pg_temp.new_order('00000000-0000-4000-8000-0000000000b2', null::uuid);
select pg_temp.line('00000000-0000-4000-8000-0000000000b2', 'a', 1);
select pg_temp.line('00000000-0000-4000-8000-0000000000b2', 'b', 1);
select pg_temp.check(pg_temp.pay('00000000-0000-4000-8000-0000000000b2'), 'split order paid');
select pg_temp.check(not shop.fittings_ship_from_location('00000000-0000-4000-8000-0000000000b2', pg_temp.loc('ART'), 'USPS', '9400', '', 'Art'),
  'one of two locations shipped: not done yet');
select pg_temp.check((select status = 'paid' from shop.fittings_orders where id = '00000000-0000-4000-8000-0000000000b2'), 'the order is still paid, not shipped');
select pg_temp.check(shop.fittings_ship_from_location('00000000-0000-4000-8000-0000000000b2', pg_temp.loc('MAIN'), 'UPS', '1Zmain', '', 'Matt'),
  'the second location shipped: done');
select pg_temp.check((select status = 'shipped' from shop.fittings_orders where id = '00000000-0000-4000-8000-0000000000b2'), 'now the order is shipped');
select pg_temp.check((select count(*) = 2 from shop.fittings_shipments where order_id = '00000000-0000-4000-8000-0000000000b2'), 'one shipment per location');

-- Returns ------------------------------------------------------------------------------
select pg_temp.check((shop.fittings_return_items('00000000-0000-4000-8000-0000000000b1', '[{"product_id":"a","qty":1}]', true, 'wrong size')->>'returned')::int = 1,
  'one of two parts comes back');
select pg_temp.check(pg_temp.onhand('a', 'MCD') = 1, 'it went back on McCormick''s shelf');
select pg_temp.check((select kind = 'return' and delta = 1 and note = 'wrong size' from shop.fittings_stock_moves where order_id = '00000000-0000-4000-8000-0000000000b1' order by id desc limit 1),
  'the stock history shows a return');
select pg_temp.check(pg_temp.lines('00000000-0000-4000-8000-0000000000b1')
  = 'mccormick-diesel: routed parts 2000 ship 0 pays 120+0 earns 0 net 1880; mccormick-diesel: reversal parts -1000 ship 0 pays -60+0 earns 0 net -940',
  'a reversing line takes back half the sale and half the share');
select pg_temp.check(pg_temp.balance('00000000-0000-4000-8000-0000000000b1', 'mccormick-diesel') = 940, 'McCormick is owed for the part it kept selling');
select pg_temp.fails($q$select shop.fittings_return_items('00000000-0000-4000-8000-0000000000b1', '[{"product_id":"a","qty":2}]', true, '')$q$,
  'can''t return more than is still out');
select shop.fittings_return_items('00000000-0000-4000-8000-0000000000b1', '[{"product_id":"a","qty":1}]', false, 'broken');
select pg_temp.check(pg_temp.onhand('a', 'MCD') = 1, 'a part that can''t be resold does not go back on the shelf');
select pg_temp.check(pg_temp.balance('00000000-0000-4000-8000-0000000000b1', 'mccormick-diesel') = 0, 'all returned: McCormick''s balance on the order is zero');
select pg_temp.fails($q$update shop.fittings_returns set qty = 5$q$, 'returns are kept as written');
select pg_temp.fails($q$delete from shop.fittings_settlements where kind = 'reversal'$q$, 'reversal lines are kept');

-- A dealer storefront sale that Arthur shipped, returned in full.
insert into shop.fittings_onhand (product_id, location_id, qty) values ('b', pg_temp.loc('ART'), 1) on conflict (product_id, location_id) do update set qty = 1;
select pg_temp.new_order('00000000-0000-4000-8000-0000000000b3', pg_temp.dealer('mccormick-diesel'));
select pg_temp.line('00000000-0000-4000-8000-0000000000b3', 'b', 1);
select pg_temp.check(pg_temp.pay('00000000-0000-4000-8000-0000000000b3'), 'McCormick-store order paid');
select shop.fittings_return_items('00000000-0000-4000-8000-0000000000b3', '[{"product_id":"b","qty":1}]', true, 'cancelled');
select pg_temp.check(pg_temp.balance('00000000-0000-4000-8000-0000000000b3', 'arthur-ag') = 0 and pg_temp.balance('00000000-0000-4000-8000-0000000000b3', 'mccormick-diesel') = 0,
  'both the shipper''s line and the seller''s share are reversed');
select pg_temp.check(pg_temp.onhand('b', 'ART') = 1, 'the part is back on Arthur''s shelf');

-- A mixed order, only Backroad Iron's part comes back.
insert into shop.fittings_onhand (product_id, location_id, qty) values ('b', pg_temp.loc('MCD'), 1), ('a', pg_temp.loc('MAIN'), 1)
  on conflict (product_id, location_id) do update set qty = excluded.qty;
select pg_temp.new_order('00000000-0000-4000-8000-0000000000b4', pg_temp.dealer('mccormick-diesel'));
select pg_temp.line('00000000-0000-4000-8000-0000000000b4', 'a', 1);
select pg_temp.line('00000000-0000-4000-8000-0000000000b4', 'b', 1);
select pg_temp.check(pg_temp.pay('00000000-0000-4000-8000-0000000000b4'), 'mixed order paid');
select shop.fittings_return_items('00000000-0000-4000-8000-0000000000b4', '[{"product_id":"a","qty":1}]', true, '');
select pg_temp.check(pg_temp.balance('00000000-0000-4000-8000-0000000000b4', 'mccormick-diesel') = 1000,
  'McCormick keeps its own sale; only its 6% on Backroad Iron''s part comes back');

-- Refunds ------------------------------------------------------------------------------
update shop.fittings_orders set total_cents = 2000, charges_cents = 0 where id = '00000000-0000-4000-8000-0000000000b1';
select shop.fittings_record_refund('00000000-0000-4000-8000-0000000000b1', 1500, 're_1', 'returned', false);
select pg_temp.check((select refunded_cents = 1500 and status = 'shipped' from shop.fittings_orders where id = '00000000-0000-4000-8000-0000000000b1'),
  'a partial refund is added up on the order');
select pg_temp.fails($q$select shop.fittings_record_refund('00000000-0000-4000-8000-0000000000b1', 600, null, '', false)$q$, 'can''t refund more than was paid');
select shop.fittings_record_refund('00000000-0000-4000-8000-0000000000b1', 500, 're_2', '', true);
select pg_temp.check((select refunded_cents = 2000 and status = 'cancelled' from shop.fittings_orders where id = '00000000-0000-4000-8000-0000000000b1'),
  'refunding the rest can cancel the order');

-- Counter sales ------------------------------------------------------------------------
insert into shop.fittings_onhand (product_id, location_id, qty) values ('a', pg_temp.loc('MAIN'), 3) on conflict (product_id, location_id) do update set qty = 3;
select pg_temp.fails($q$select shop.fittings_counter_sale(pg_temp.loc('MAIN'), '[{"product_id":"a","qty":4,"price_cents":100}]', 'cash', '', 'Matt')$q$,
  'can''t ring up more than is on the shelf');
select pg_temp.check(pg_temp.onhand('a', 'MAIN') = 3, 'a sale that didn''t go through took nothing');
select pg_temp.check(shop.fittings_counter_sale(pg_temp.loc('MAIN'),
  '[{"product_id":"a","qty":1,"price_cents":150},{"product_id":"a","qty":1,"price_cents":150}]', 'cash', 'walk-in', 'Matt') > 0, 'counter sale rung up');
select pg_temp.check(pg_temp.onhand('a', 'MAIN') = 1, 'two came off the main shelf');
select pg_temp.check((select total_cents = 300 and jsonb_array_length(lines) = 1 and paid_by = 'cash' from shop.fittings_counter_sales order by id desc limit 1),
  'the sale is recorded with its total, same parts merged');
select pg_temp.check((select kind = 'sale' and delta = -2 and note like 'Counter sale #%walk-in' from shop.fittings_stock_moves where product_id = 'a' order by id desc limit 1),
  'the stock history shows the counter sale');
select pg_temp.check((select qty from shop.fittings_products where id = 'a') = (select sum(qty) from shop.fittings_onhand where product_id = 'a'),
  'the item total still matches its shelves');
select pg_temp.fails($q$select shop.fittings_counter_sale(pg_temp.loc('MAIN'), '[]', 'cash', '', '')$q$, 'an empty sale is refused');

-- Spreadsheet import -------------------------------------------------------------------------
select pg_temp.check(shop.fittings_import_counts(pg_temp.loc('MCD'),
  '[{"product_id":"a","qty":7,"price_cents":1250},{"product_id":"b","qty":0,"price_cents":null}]', 'Spreadsheet import') = 1,
  'only the count that changed is written');
select pg_temp.check(pg_temp.onhand('a', 'MCD') = 7 and (select price_cents from shop.fittings_products where id = 'a') = 1250,
  'the count and the price are set');
select pg_temp.check((select kind = 'count' and note = 'Spreadsheet import' from shop.fittings_stock_moves where product_id = 'a' order by id desc limit 1),
  'the import shows in the stock history as a recount');
select pg_temp.fails($q$select shop.fittings_import_counts(pg_temp.loc('MCD'), '[{"product_id":"nope","qty":1}]', '')$q$, 'an unknown item stops the import');
select pg_temp.check(pg_temp.onhand('a', 'MCD') = 7, 'a stopped import changes nothing');

-- Dealer users and alerts -------------------------------------------------------------------
select pg_temp.fails($q$insert into shop.fittings_dealer_users (dealer_id, email, password_hash) values (pg_temp.dealer('mccormick-diesel'), 'Dale@X.com', 'scrypt$a$b')$q$,
  'logins are stored in lower case');
insert into shop.fittings_dealer_users (dealer_id, email, password_hash) values (pg_temp.dealer('mccormick-diesel'), 'dale@x.com', 'scrypt$a$b');
select pg_temp.fails($q$insert into shop.fittings_dealer_users (dealer_id, email, password_hash) values (pg_temp.dealer('arthur-ag'), 'dale@x.com', 'scrypt$c$d')$q$,
  'one login per email');
insert into shop.fittings_alerts (dealer_id, order_id, topic, channel, send_to, body) values
  (pg_temp.dealer('mccormick-diesel'), '00000000-0000-4000-8000-0000000000b2', 'routed_order', 'email', 'dale@x.com', 'Pull 1 part');
insert into shop.fittings_alerts (dealer_id, order_id, topic, channel, send_to, body) values
  (pg_temp.dealer('mccormick-diesel'), '00000000-0000-4000-8000-0000000000b2', 'routed_order', 'email', 'dale@x.com', 'Pull 1 part')
  on conflict do nothing;
select pg_temp.check((select count(*) = 1 from shop.fittings_alerts), 'an order alerts a dealer once per channel');
select pg_temp.check(not has_table_privilege('anon', 'shop.fittings_dealer_users', 'select'), 'shoppers can''t read dealer logins');

rollback;
select 'all passed';
