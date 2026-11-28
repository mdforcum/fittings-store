-- Checks for add-dealer-roles.sql (scratch database with every shop change
-- loaded, items a and b):
--   psql -v ON_ERROR_STOP=1 -d <scratch> -f supabase/test-dealer-roles.sql
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
create or replace function pg_temp.person(text) returns uuid language sql as $$ select id from shop.fittings_dealer_users where email = $1 $$;
create or replace function pg_temp.onhand(text, text) returns int language sql as $$
  select coalesce((select qty from shop.fittings_onhand where product_id = $1 and location_id = pg_temp.loc($2)), 0)
$$;

insert into shop.fittings_dealers (name, slug) values ('Arthur Ag', 'arthur-ag');
update shop.fittings_locations set zip = '62565', state = 'IL' where code = 'MAIN';
insert into shop.fittings_locations (name, kind, dealer_id, code, state, zip, takes_routed) values
  ('McCormick shop', 'store', pg_temp.dealer('mccormick-diesel'), 'MCD', 'IL', '61951', true),
  ('Arthur yard', 'store', pg_temp.dealer('arthur-ag'), 'ART', 'IL', '61911', true);
update shop.fittings_settings set route_orders = true where id = 1;
delete from shop.fittings_onhand where product_id in ('a', 'b');
insert into shop.fittings_onhand (product_id, location_id, qty) values ('a', pg_temp.loc('MCD'), 20);

-- People. New logins are workers.
insert into shop.fittings_dealer_users (dealer_id, email, name, password_hash) values
  (pg_temp.dealer('mccormick-diesel'), 'doc@mcd.example', 'Doc', 'scrypt$00$00'),
  (pg_temp.dealer('mccormick-diesel'), 'kim@mcd.example', 'Kim', 'scrypt$00$00'),
  (pg_temp.dealer('mccormick-diesel'), 'lee@mcd.example', 'Lee', 'scrypt$00$00'),
  (pg_temp.dealer('arthur-ag'), 'art@arthur.example', 'Art', 'scrypt$00$00');
select pg_temp.check((select bool_and(role = 'worker') from shop.fittings_dealer_users), 'a new login starts as a worker');
update shop.fittings_dealer_users set role = 'manager' where email in ('doc@mcd.example', 'art@arthur.example');
select pg_temp.fails($q$update shop.fittings_dealer_users set role = 'owner' where email = 'kim@mcd.example'$q$, 'a role is manager or worker');
select pg_temp.check((select ship_check = 'off' and count_hold_over = 5 from shop.fittings_dealers where slug = 'mccormick-diesel'), 'a dealer starts with no second check and a hold over 5');
select pg_temp.fails($q$update shop.fittings_dealers set ship_check = 'sometimes' where slug = 'mccormick-diesel'$q$, 'the second check is off, any or manager');

-- Three routed orders that McCormick fills.
select pg_temp.new_order('00000000-0000-4000-8000-0000000000e1', null::uuid); select pg_temp.line('00000000-0000-4000-8000-0000000000e1', 'a', 1);
select pg_temp.new_order('00000000-0000-4000-8000-0000000000e2', null::uuid); select pg_temp.line('00000000-0000-4000-8000-0000000000e2', 'a', 1);
select pg_temp.new_order('00000000-0000-4000-8000-0000000000e3', null::uuid); select pg_temp.line('00000000-0000-4000-8000-0000000000e3', 'a', 1);
select pg_temp.new_order('00000000-0000-4000-8000-0000000000e4', null::uuid); select pg_temp.line('00000000-0000-4000-8000-0000000000e4', 'a', 1);
select pg_temp.check(pg_temp.pay('00000000-0000-4000-8000-0000000000e1') and pg_temp.pay('00000000-0000-4000-8000-0000000000e2')
  and pg_temp.pay('00000000-0000-4000-8000-0000000000e3') and pg_temp.pay('00000000-0000-4000-8000-0000000000e4'), 'four routed orders paid');

-- With the check off, shipping works as before.
select pg_temp.check(not shop.fittings_ship_check_needed('00000000-0000-4000-8000-0000000000e1', pg_temp.loc('MCD')), 'no check is needed while the dealer has it off');
select pg_temp.check(shop.fittings_ship_from_location('00000000-0000-4000-8000-0000000000e1', pg_temp.loc('MCD'), 'UPS', '1ZOFF', '', 'Doc'), 'with the check off an order ships as before');

-- Any second person.
update shop.fittings_dealers set ship_check = 'any' where slug = 'mccormick-diesel';
select pg_temp.check(shop.fittings_ship_check_needed('00000000-0000-4000-8000-0000000000e2', pg_temp.loc('MCD')), 'with the check on, an unchecked order needs it');
select pg_temp.fails($q$select shop.fittings_ship_from_location('00000000-0000-4000-8000-0000000000e2', pg_temp.loc('MCD'), 'UPS', '1ZNO', '', 'Kim')$q$,
  'tracking can''t be saved before the check');
select pg_temp.fails($q$select shop.fittings_dealer_label('00000000-0000-4000-8000-0000000000e2', pg_temp.loc('MCD'), 'UPS', 'Ground', '1Z', '', 'tx', 100, 100, 'Kim')$q$,
  'a label can''t be recorded before the check');
select pg_temp.check((select count(*) = 0 from shop.fittings_shipments where order_id = '00000000-0000-4000-8000-0000000000e2'), 'nothing was written');
select pg_temp.fails($q$select shop.fittings_ship_check_pass('00000000-0000-4000-8000-0000000000e2', pg_temp.loc('MCD'), pg_temp.person('doc@mcd.example'), '')$q$,
  'an order can''t be checked before it is packed');
select pg_temp.fails($q$select shop.fittings_ship_check_pack('00000000-0000-4000-8000-0000000000e2', pg_temp.loc('MCD'), pg_temp.person('art@arthur.example'))$q$,
  'another dealer''s person can''t pack it');
select shop.fittings_ship_check_pack('00000000-0000-4000-8000-0000000000e2', pg_temp.loc('MCD'), pg_temp.person('kim@mcd.example'));
select pg_temp.check(shop.fittings_ship_check_needed('00000000-0000-4000-8000-0000000000e2', pg_temp.loc('MCD')), 'packed is not checked');
select pg_temp.fails($q$select shop.fittings_ship_check_pass('00000000-0000-4000-8000-0000000000e2', pg_temp.loc('MCD'), pg_temp.person('kim@mcd.example'), '')$q$,
  'the person who packed can''t be the one who checks');
select pg_temp.fails($q$select shop.fittings_ship_check_pass('00000000-0000-4000-8000-0000000000e2', pg_temp.loc('MCD'), pg_temp.person('art@arthur.example'), '')$q$,
  'another dealer''s person can''t check it');
select pg_temp.fails($q$select shop.fittings_ship_check_pass('00000000-0000-4000-8000-0000000000e2', pg_temp.loc('MCD'), pg_temp.person('kim@mcd.example'), 'I am alone today')$q$,
  'a worker can''t override');
select pg_temp.check(shop.fittings_ship_check_pass('00000000-0000-4000-8000-0000000000e2', pg_temp.loc('MCD'), pg_temp.person('lee@mcd.example'), '') = 'checked',
  'any second person can check, worker or not');
select pg_temp.fails($q$select shop.fittings_ship_check_pass('00000000-0000-4000-8000-0000000000e2', pg_temp.loc('MCD'), pg_temp.person('doc@mcd.example'), '')$q$,
  'an order is checked once');
select pg_temp.fails($q$select shop.fittings_ship_check_pack('00000000-0000-4000-8000-0000000000e2', pg_temp.loc('MCD'), pg_temp.person('doc@mcd.example'))$q$,
  'a checked order can''t be sent back to packed');
select pg_temp.check(shop.fittings_ship_from_location('00000000-0000-4000-8000-0000000000e2', pg_temp.loc('MCD'), 'UPS', '1ZOK', '', 'Lee'), 'once checked, it ships');
select pg_temp.check((select packed_name = 'Kim' and checked_name = 'Lee' and override_reason = '' from shop.fittings_ship_checks where order_id = '00000000-0000-4000-8000-0000000000e2'),
  'the record says who packed and who checked');
select pg_temp.check(shop.fittings_ship_from_location('00000000-0000-4000-8000-0000000000e2', pg_temp.loc('MCD'), 'UPS', '1ZFIXED', '', 'Lee'), 'fixing the tracking afterwards still works');

-- Manager only.
update shop.fittings_dealers set ship_check = 'manager' where slug = 'mccormick-diesel';
select shop.fittings_ship_check_pack('00000000-0000-4000-8000-0000000000e3', pg_temp.loc('MCD'), pg_temp.person('kim@mcd.example'));
select pg_temp.fails($q$select shop.fittings_ship_check_pass('00000000-0000-4000-8000-0000000000e3', pg_temp.loc('MCD'), pg_temp.person('lee@mcd.example'), '')$q$,
  'when a manager is asked for, a worker can''t check');
select pg_temp.check(shop.fittings_ship_check_pass('00000000-0000-4000-8000-0000000000e3', pg_temp.loc('MCD'), pg_temp.person('doc@mcd.example'), '') = 'checked', 'a manager can');

-- A one-person shop: the manager packs, then overrides with a reason.
select shop.fittings_ship_check_pack('00000000-0000-4000-8000-0000000000e4', pg_temp.loc('MCD'), pg_temp.person('doc@mcd.example'));
select pg_temp.fails($q$select shop.fittings_ship_check_pass('00000000-0000-4000-8000-0000000000e4', pg_temp.loc('MCD'), pg_temp.person('doc@mcd.example'), '')$q$,
  'even a manager can''t check their own packing without a reason');
select pg_temp.fails($q$select shop.fittings_ship_check_pass('00000000-0000-4000-8000-0000000000e4', pg_temp.loc('MCD'), pg_temp.person('doc@mcd.example'), 'ok')$q$,
  'the reason has to say something');
select pg_temp.check(shop.fittings_ship_check_pass('00000000-0000-4000-8000-0000000000e4', pg_temp.loc('MCD'), pg_temp.person('doc@mcd.example'), 'Alone in the shop today') = 'override',
  'a manager can override with a reason');
select pg_temp.check((select override_reason = 'Alone in the shop today' and checked_name = 'Doc' from shop.fittings_ship_checks where order_id = '00000000-0000-4000-8000-0000000000e4'),
  'the override and its reason are kept');
select pg_temp.check(shop.fittings_ship_from_location('00000000-0000-4000-8000-0000000000e4', pg_temp.loc('MCD'), 'UPS', '1ZOVR', '', 'Doc'), 'an overridden order ships');

-- A disabled login can do none of it.
update shop.fittings_dealer_users set disabled = true where email = 'lee@mcd.example';
select pg_temp.fails($q$select shop.fittings_ship_check_pack('00000000-0000-4000-8000-0000000000e3', pg_temp.loc('MCD'), pg_temp.person('lee@mcd.example'))$q$, 'a disabled login can''t pack');

-- Held counts.
insert into shop.fittings_count_requests (dealer_id, location_id, product_id, from_qty, to_qty, asked_by, asked_name)
  values (pg_temp.dealer('mccormick-diesel'), pg_temp.loc('MCD'), 'a', 16, 40, pg_temp.person('kim@mcd.example'), 'Kim');
select pg_temp.fails($q$insert into shop.fittings_count_requests (dealer_id, location_id, product_id, from_qty, to_qty) values (pg_temp.dealer('mccormick-diesel'), pg_temp.loc('MCD'), 'a', 16, 41)$q$,
  'one open request per part and location');
select pg_temp.fails($q$select shop.fittings_count_decide((select id from shop.fittings_count_requests where status = 'pending'), pg_temp.person('kim@mcd.example'), true)$q$,
  'a worker can''t approve a count');
select pg_temp.fails($q$select shop.fittings_count_decide((select id from shop.fittings_count_requests where status = 'pending'), pg_temp.person('art@arthur.example'), true)$q$,
  'another dealer''s manager can''t approve it');
select pg_temp.check(pg_temp.onhand('a', 'MCD') = 16, 'the count has not moved while it waits');
select pg_temp.check(shop.fittings_count_decide((select id from shop.fittings_count_requests where status = 'pending'), pg_temp.person('doc@mcd.example'), true) = 'approved', 'a manager approves');
select pg_temp.check(pg_temp.onhand('a', 'MCD') = 40, 'approving sets the count');
select pg_temp.check((select note = 'Count by Kim, approved by Doc' and kind = 'count' from shop.fittings_stock_moves where product_id = 'a' order by id desc limit 1),
  'the stock history says who asked and who approved');
select pg_temp.fails($q$select shop.fittings_count_decide((select max(id) from shop.fittings_count_requests), pg_temp.person('doc@mcd.example'), true)$q$, 'a request is decided once');
insert into shop.fittings_count_requests (dealer_id, location_id, product_id, from_qty, to_qty, asked_by, asked_name)
  values (pg_temp.dealer('mccormick-diesel'), pg_temp.loc('MCD'), 'a', 40, 2, pg_temp.person('kim@mcd.example'), 'Kim');
select pg_temp.check(shop.fittings_count_decide((select id from shop.fittings_count_requests where status = 'pending'), pg_temp.person('doc@mcd.example'), false) = 'declined', 'a manager declines');
select pg_temp.check(pg_temp.onhand('a', 'MCD') = 40, 'declining leaves the count alone');

-- The activity log.
select pg_temp.check((select string_agg(action, ',' order by id) from shop.fittings_dealer_events where dealer_id = pg_temp.dealer('mccormick-diesel'))
  = 'packed,checked,packed,checked,packed,override,count_approved,count_declined', 'every step is in the activity log, in order');
select pg_temp.check((select detail->>'name' = 'Cap' and detail->>'asked_by' = 'Kim' and detail->>'to' = '40' from shop.fittings_dealer_events where action = 'count_approved'),
  'an approval names the part, the count and who asked');
select pg_temp.check((select user_name = 'Doc' and role = 'manager' and detail->>'reason' = 'Alone in the shop today' and detail->>'packed_by' = 'Doc'
  from shop.fittings_dealer_events where action = 'override'), 'the log says who overrode, and why');
select pg_temp.fails($q$update shop.fittings_dealer_events set user_name = 'Nobody' where action = 'override'$q$, 'the activity log can''t be edited');

-- Backroad Iron's own shipments are untouched: its dealer has the check off.
select pg_temp.check((select ship_check = 'off' from shop.fittings_dealers where slug = 'backroad-iron'), 'Backroad Iron itself starts with the check off');

do $$ begin raise notice 'all passed'; end $$;
rollback;
