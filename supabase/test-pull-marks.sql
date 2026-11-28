-- Checks for add-pull-marks.sql (scratch database with every shop change loaded):
--   psql -v ON_ERROR_STOP=1 -d <scratch> -f supabase/test-pull-marks.sql
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

insert into shop.fittings_orders (id, status, ship_method) values ('00000000-0000-4000-8000-0000000000f1', 'paid', 'parcel');
insert into shop.fittings_pull_marks (order_id, location_id, product_id, picked_qty, picked_name)
  select '00000000-0000-4000-8000-0000000000f1', id, 'a', 2, 'Kim' from shop.fittings_locations where code = 'MAIN';
select pg_temp.check((select picked_qty = 2 and picked_name = 'Kim' and picked_at is not null from shop.fittings_pull_marks), 'a check-off is kept with who pulled it');
select pg_temp.fails($q$insert into shop.fittings_pull_marks (order_id, location_id, product_id, picked_qty) select '00000000-0000-4000-8000-0000000000f1', id, 'a', 1 from shop.fittings_locations where code = 'MAIN'$q$,
  'one line per order, location and part');
select pg_temp.fails($q$update shop.fittings_pull_marks set picked_qty = -1$q$, 'a pulled count can''t go below zero');
update shop.fittings_pull_marks set picked_qty = 0;
select pg_temp.check((select picked_qty = 0 from shop.fittings_pull_marks), 'a check-off can be taken back');
delete from shop.fittings_orders where id = '00000000-0000-4000-8000-0000000000f1';
select pg_temp.check((select count(*) = 0 from shop.fittings_pull_marks), 'check-offs go when the order goes');
select pg_temp.check((select relrowsecurity from pg_class where oid = 'shop.fittings_pull_marks'::regclass), 'only the site''s server can read it');
do $$ begin raise notice 'all passed'; end $$;
rollback;
