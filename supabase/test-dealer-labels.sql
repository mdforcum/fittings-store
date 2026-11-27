-- Checks for add-dealer-labels.sql (scratch database with every shop change
-- loaded, items a and b):
--   psql -v ON_ERROR_STOP=1 -d <scratch> -f supabase/test-dealer-labels.sql
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


-- A routed order McCormick fills: the ledger writer still works with label lines allowed.
insert into shop.fittings_onhand (product_id, location_id, qty) values ('a', pg_temp.loc('MCD'), 2);
select pg_temp.new_order('00000000-0000-4000-8000-0000000000c1', null::uuid);
select pg_temp.line('00000000-0000-4000-8000-0000000000c1', 'a', 2);
select pg_temp.check(pg_temp.pay('00000000-0000-4000-8000-0000000000c1'), 'routed order paid');
select pg_temp.check(pg_temp.lines('00000000-0000-4000-8000-0000000000c1') = 'mccormick-diesel: routed parts 2000 ship 0 pays 120+0 earns 0 net 1880',
  'paying still writes the dealer''s sale line');
select pg_temp.fails($q$insert into shop.fittings_settlements (order_id, dealer_id, kind, parts_cents, shipping_cents, cut_bps, cut_cents, net_cents)
  values ('00000000-0000-4000-8000-0000000000c1', pg_temp.dealer('mccormick-diesel'), 'routed', 1, 0, 0, 0, 1)$q$, 'still one sale line per dealer per order');

-- Buying a label ----------------------------------------------------------------------
select pg_temp.fails($q$select shop.fittings_dealer_label('00000000-0000-4000-8000-0000000000c1', pg_temp.loc('MCD'), 'UPS', 'Ground', '1Z1', '', 'tx_1', 1240, 1200, 'Doc')$q$,
  'a dealer is never charged less than the label cost');
select pg_temp.fails($q$select shop.fittings_dealer_label('00000000-0000-4000-8000-0000000000c1', pg_temp.loc('ART'), 'UPS', 'Ground', '1Z1', '', 'tx_1', 1240, 1240, 'Doc')$q$,
  'a location with no parts on the order can''t buy its label');
select pg_temp.check(shop.fittings_dealer_label('00000000-0000-4000-8000-0000000000c1', pg_temp.loc('MCD'), 'UPS', 'Ground', '1Z1', 'https://t/1Z1', 'tx_1', 1240, 1240, 'Doc')
  = '{"shipped": true, "charge_cents": 1240}'::jsonb, 'a label at cost is recorded and finishes the order');
select pg_temp.check((select status = 'shipped' and tracking_number = '1Z1' and carrier = 'UPS' from shop.fittings_orders where id = '00000000-0000-4000-8000-0000000000c1'),
  'the order is shipped with the label''s tracking');
select pg_temp.check((select service = 'Ground' and shippo_transaction_id = 'tx_1' and label_cost_cents = 1240 and label_charge_cents = 1240 and shipped_by = 'Doc'
  from shop.fittings_shipments where order_id = '00000000-0000-4000-8000-0000000000c1'), 'the shipment keeps the label''s cost and charge');
select pg_temp.check(pg_temp.lines('00000000-0000-4000-8000-0000000000c1')
  = 'mccormick-diesel: routed parts 2000 ship 0 pays 120+0 earns 0 net 1880; mccormick-diesel: label parts 0 ship -1240 pays 0+0 earns 0 net -1240',
  'the dealer''s statement gets a label line');
select pg_temp.check((select reason = 'Label: UPS Ground 1Z1' and card_fee_cents = 0 from shop.fittings_settlements where kind = 'label'), 'the line says which label');
select pg_temp.check(pg_temp.balance('00000000-0000-4000-8000-0000000000c1', 'mccormick-diesel') = 640, 'the sale less the label is what the dealer is owed');
select pg_temp.fails($q$select shop.fittings_dealer_label('00000000-0000-4000-8000-0000000000c1', pg_temp.loc('MCD'), 'UPS', 'Ground', '1Z2', '', 'tx_2', 900, 900, 'Doc')$q$,
  'a second label for the same location is refused');
select pg_temp.fails($q$delete from shop.fittings_settlements where kind = 'label'$q$, 'label lines are kept');
select pg_temp.fails($q$update shop.fittings_settlements set shipping_cents = 0 where kind = 'label'$q$, 'a label line''s amount can''t be changed');
select pg_temp.fails($q$insert into shop.fittings_settlements (order_id, dealer_id, kind, parts_cents, shipping_cents, cut_bps, cut_cents, net_cents)
  values ('00000000-0000-4000-8000-0000000000c1', pg_temp.dealer('mccormick-diesel'), 'label', 5, -1, 0, 0, -1)$q$, 'a label line carries only a shipping amount');

-- A marked-up label (when Backroad Iron sets a markup).
insert into shop.fittings_onhand (product_id, location_id, qty) values ('b', pg_temp.loc('ART'), 1), ('a', pg_temp.loc('MAIN'), 1)
  on conflict (product_id, location_id) do update set qty = excluded.qty;
select pg_temp.new_order('00000000-0000-4000-8000-0000000000c2', null::uuid);
select pg_temp.line('00000000-0000-4000-8000-0000000000c2', 'a', 1);
select pg_temp.line('00000000-0000-4000-8000-0000000000c2', 'b', 1);
select pg_temp.check(pg_temp.pay('00000000-0000-4000-8000-0000000000c2'), 'two-location order paid');
select pg_temp.check((shop.fittings_dealer_label('00000000-0000-4000-8000-0000000000c2', pg_temp.loc('ART'), 'USPS', 'Priority', '9400', '', 'tx_3', 800, 850, 'Art')->>'shipped')::boolean = false,
  'one of two locations bought its label: the order isn''t finished');
select pg_temp.check((select net_cents = -850 from shop.fittings_settlements where kind = 'label' and dealer_id = pg_temp.dealer('arthur-ag')),
  'the dealer is charged what it was quoted, markup included');
select pg_temp.check((select label_charge_cents - label_cost_cents = 50 from shop.fittings_shipments where shippo_transaction_id = 'tx_3'), 'the margin can be read off the shipment');
select pg_temp.check((shop.fittings_dealer_label('00000000-0000-4000-8000-0000000000c2', pg_temp.loc('MAIN'), 'UPS', 'Ground', '1ZM', '', 'tx_4', 700, 700, 'Matt')->>'shipped')::boolean,
  'the main shop''s label finishes the order');
select pg_temp.check((select count(*) = 2 from shop.fittings_settlements where kind = 'label'), 'Backroad Iron''s own label writes no dealer line');

-- Returns ignore label lines.
select shop.fittings_return_items('00000000-0000-4000-8000-0000000000c1', '[{"product_id":"a","qty":2}]', true, 'sent back');
select pg_temp.check(pg_temp.balance('00000000-0000-4000-8000-0000000000c1', 'mccormick-diesel') = -1240,
  'a full return reverses the sale; the label the dealer bought still stands');
select pg_temp.check((select count(*) = 1 from shop.fittings_settlements where order_id = '00000000-0000-4000-8000-0000000000c1' and kind = 'reversal'),
  'the return wrote one reversing line, none for the label');

select pg_temp.check(not has_function_privilege('anon', 'shop.fittings_dealer_label(uuid, uuid, text, text, text, text, text, integer, integer, text)', 'execute'),
  'shoppers can''t record labels');

rollback;
select 'all passed';
