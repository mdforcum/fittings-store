-- Checks for add-label-voids.sql (scratch database with every shop change
-- loaded, items a and b):
--   psql -v ON_ERROR_STOP=1 -d <scratch> -f supabase/test-label-voids.sql
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



insert into shop.fittings_onhand (product_id, location_id, qty) values ('a', pg_temp.loc('MCD'), 2);
select pg_temp.new_order('00000000-0000-4000-8000-0000000000d1', null::uuid);
select pg_temp.line('00000000-0000-4000-8000-0000000000d1', 'a', 2);
select pg_temp.check(pg_temp.pay('00000000-0000-4000-8000-0000000000d1'), 'routed order paid');
select pg_temp.fails($q$select shop.fittings_void_label('00000000-0000-4000-8000-0000000000d1', pg_temp.loc('MCD'), 'QUEUED', 'Matt', '')$q$,
  'nothing to void before a label is bought');
select shop.fittings_ship_from_location('00000000-0000-4000-8000-0000000000d1', pg_temp.loc('MCD'), 'UPS', 'typed-in', '', 'Doc');
select pg_temp.fails($q$select shop.fittings_void_label('00000000-0000-4000-8000-0000000000d1', pg_temp.loc('MCD'), 'QUEUED', 'Matt', '')$q$,
  'a shipment with typed-in tracking has no label to void');
delete from shop.fittings_shipments where order_id = '00000000-0000-4000-8000-0000000000d1';
update shop.fittings_orders set status = 'paid', shipped_at = null, carrier = null, tracking_number = null where id = '00000000-0000-4000-8000-0000000000d1';

select shop.fittings_dealer_label('00000000-0000-4000-8000-0000000000d1', pg_temp.loc('MCD'), 'UPS', 'Ground', '1Z1', 'https://t/1Z1', 'tx_1', 1240, 1302, 'Doc');
select pg_temp.check(pg_temp.balance('00000000-0000-4000-8000-0000000000d1', 'mccormick-diesel') = 1880 - 1302, 'the label is on the dealer''s statement');
select pg_temp.check(shop.fittings_void_label('00000000-0000-4000-8000-0000000000d1', pg_temp.loc('MCD'), 'QUEUED', 'Matt', 'wrong box')
  = '{"credit_cents": 1302}'::jsonb, 'voiding gives back what the dealer was charged');
select pg_temp.check(pg_temp.balance('00000000-0000-4000-8000-0000000000d1', 'mccormick-diesel') = 1880, 'the statement is back to the sale alone');
select pg_temp.check((select count(*) = 2 and sum(net_cents) = 0 from shop.fittings_settlements where order_id = '00000000-0000-4000-8000-0000000000d1' and kind = 'label'),
  'the charge and the credit both stay on the record');
select pg_temp.check((select reason = 'Label voided: UPS 1Z1' from shop.fittings_settlements where kind = 'label' and net_cents > 0), 'the credit line says which label');
select pg_temp.check((select status = 'paid' and shipped_at is null and tracking_number is null and carrier is null from shop.fittings_orders where id = '00000000-0000-4000-8000-0000000000d1'),
  'the order goes back to to-ship with no tracking');
select pg_temp.check(not exists (select 1 from shop.fittings_shipments where order_id = '00000000-0000-4000-8000-0000000000d1'), 'the shipment is off the order');
select pg_temp.check((select shippo_transaction_id = 'tx_1' and label_cost_cents = 1240 and label_charge_cents = 1302 and refund_status = 'QUEUED' and voided_by = 'Matt' and reason = 'wrong box'
  from shop.fittings_label_voids), 'the void is kept with who, why and what the refund said');
select pg_temp.fails($q$delete from shop.fittings_label_voids$q$, 'void records are kept as written');
select pg_temp.fails($q$select shop.fittings_void_label('00000000-0000-4000-8000-0000000000d1', pg_temp.loc('MCD'), 'QUEUED', 'Matt', '')$q$, 'a label can''t be voided twice');
select pg_temp.check((shop.fittings_dealer_label('00000000-0000-4000-8000-0000000000d1', pg_temp.loc('MCD'), 'USPS', 'Priority', '9400', '', 'tx_2', 985, 985, 'Doc')->>'shipped')::boolean,
  'a new label can be bought after the void');

-- Two locations: voiding one leaves the other's shipment alone.
insert into shop.fittings_onhand (product_id, location_id, qty) values ('b', pg_temp.loc('ART'), 1), ('a', pg_temp.loc('MAIN'), 1)
  on conflict (product_id, location_id) do update set qty = excluded.qty;
select pg_temp.new_order('00000000-0000-4000-8000-0000000000d2', null::uuid);
select pg_temp.line('00000000-0000-4000-8000-0000000000d2', 'a', 1);
select pg_temp.line('00000000-0000-4000-8000-0000000000d2', 'b', 1);
select pg_temp.check(pg_temp.pay('00000000-0000-4000-8000-0000000000d2'), 'two-location order paid');
select shop.fittings_dealer_label('00000000-0000-4000-8000-0000000000d2', pg_temp.loc('MAIN'), 'UPS', 'Ground', '1ZM', '', 'tx_3', 700, 700, 'Matt');
select shop.fittings_dealer_label('00000000-0000-4000-8000-0000000000d2', pg_temp.loc('ART'), 'USPS', 'Priority', '9401', '', 'tx_4', 800, 800, 'Art');
select pg_temp.check((select status = 'shipped' and tracking_number = '9401' from shop.fittings_orders where id = '00000000-0000-4000-8000-0000000000d2'), 'both shipped: order done');
select shop.fittings_void_label('00000000-0000-4000-8000-0000000000d2', pg_temp.loc('ART'), 'PENDING', 'Matt', '');
select pg_temp.check((select status = 'paid' and tracking_number is null from shop.fittings_orders where id = '00000000-0000-4000-8000-0000000000d2'),
  'voiding one location reopens the order and takes its tracking off');
select pg_temp.check((select count(*) = 1 from shop.fittings_shipments where order_id = '00000000-0000-4000-8000-0000000000d2'), 'the other location''s shipment stays');
select pg_temp.check((shop.fittings_void_label('00000000-0000-4000-8000-0000000000d2', pg_temp.loc('MAIN'), 'SUCCESS', 'Matt', '')->>'credit_cents')::int = 0,
  'voiding Backroad Iron''s own label credits no dealer');
select pg_temp.check(not has_function_privilege('anon', 'shop.fittings_void_label(uuid, uuid, text, text, text)', 'execute') and not has_table_privilege('anon', 'shop.fittings_label_voids', 'select'),
  'shoppers can''t void labels or read voids');

rollback;
select 'all passed';
