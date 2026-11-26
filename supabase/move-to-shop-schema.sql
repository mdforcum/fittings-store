-- One-time move (2026-11-25): the shop's objects from public to schema shop.
-- Tables take their indexes, constraints, triggers, policies, grants and owned
-- sequences with them. Functions are moved and given the new search path.
-- Run once, after `shop` is added to the Data API's exposed schemas.
begin;
create schema if not exists shop;
grant usage on schema shop to anon, authenticated, service_role;
do $$
declare r record;
begin
  for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relname like 'fittings\_%' loop
    execute format('alter table public.%I set schema shop', r.relname);
  end loop;
  -- Sequences not owned by a moved column (none expected) follow too.
  for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'S' and c.relname like 'fittings\_%' loop
    execute format('alter sequence public.%I set schema shop', r.relname);
  end loop;
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'fittings\_%' loop
    execute format('alter function %s set schema shop', r.sig);
  end loop;
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'shop' and p.proname like 'fittings\_%' loop
    execute format('alter function %s set search_path = shop, public, extensions', r.sig);
  end loop;
end $$;
commit;
notify pgrst, 'reload schema';
select
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname like 'fittings\_%') as left_in_public,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'shop' and c.relkind = 'r') as shop_tables,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'fittings\_%') as functions_left_in_public;
