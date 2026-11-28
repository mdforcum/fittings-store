-- ---------------------------------------------------------------------------
-- Dealer roles, the second check before shipping, held counts, and a record
-- of who did what.
--
--   * Each dealer login is a manager or a worker.
--   * A dealer can ask for a second check before an order ships: by any second
--     person, or by a manager. The person who packed can't be the one who
--     checks. A manager can override with a written reason (a one-person shop
--     needs a way through), and the override is kept.
--   * A worker's count that moves a number by more than the dealer's set
--     amount waits for a manager's OK.
--   * Every one of these steps is written to an activity log that can't be
--     edited.
--
-- Needs add-operations.sql. Safe to run more than once.
-- ---------------------------------------------------------------------------

-- Roles. Logins that existed before roles become managers, so nobody loses
-- anything they could do yesterday; new logins start as workers.
do $$ begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'shop' and table_name = 'fittings_dealer_users' and column_name = 'role') then
    alter table shop.fittings_dealer_users add column role text not null default 'worker';
    update shop.fittings_dealer_users set role = 'manager';
    alter table shop.fittings_dealer_users add constraint fittings_dealer_users_role check (role in ('manager', 'worker'));
  end if;
end $$;

-- Each dealer's own rules.
alter table shop.fittings_dealers
  add column if not exists ship_check text not null default 'off',
  add column if not exists count_hold_over integer not null default 5;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'fittings_dealers_ship_check') then
    alter table shop.fittings_dealers add constraint fittings_dealers_ship_check check (ship_check in ('off', 'any', 'manager'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fittings_dealers_count_hold') then
    alter table shop.fittings_dealers add constraint fittings_dealers_count_hold check (count_hold_over between 0 and 100000);
  end if;
end $$;

-- Who did what. Written by the functions below and by the dealer page; never changed.
create table if not exists shop.fittings_dealer_events (
  id bigint generated always as identity primary key,
  dealer_id uuid not null references shop.fittings_dealers(id) on delete cascade,
  user_id uuid references shop.fittings_dealer_users(id) on delete set null,
  user_name text not null default '',
  role text not null default '',
  action text not null,
  order_id uuid references shop.fittings_orders(id) on delete set null,
  location_id uuid references shop.fittings_locations(id) on delete set null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists fittings_dealer_events_recent on shop.fittings_dealer_events(dealer_id, id desc);
drop trigger if exists fittings_dealer_events_frozen on shop.fittings_dealer_events;
create trigger fittings_dealer_events_frozen before update on shop.fittings_dealer_events for each row execute function shop.fittings_frozen();

-- One line per order and location: who packed it, who checked it.
create table if not exists shop.fittings_ship_checks (
  order_id uuid not null references shop.fittings_orders(id) on delete cascade,
  location_id uuid not null references shop.fittings_locations(id) on delete cascade,
  packed_by uuid references shop.fittings_dealer_users(id) on delete set null,
  packed_name text not null default '',
  packed_at timestamptz not null default now(),
  checked_by uuid references shop.fittings_dealer_users(id) on delete set null,
  checked_name text not null default '',
  checked_at timestamptz,
  override_reason text not null default '',
  primary key (order_id, location_id)
);

-- Counts waiting for a manager.
create table if not exists shop.fittings_count_requests (
  id bigint generated always as identity primary key,
  dealer_id uuid not null references shop.fittings_dealers(id) on delete cascade,
  location_id uuid not null references shop.fittings_locations(id) on delete cascade,
  product_id text not null references shop.fittings_products(id) on delete cascade,
  from_qty integer not null,
  to_qty integer not null check (to_qty between 0 and 100000),
  asked_by uuid references shop.fittings_dealer_users(id) on delete set null,
  asked_name text not null default '',
  asked_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  decided_by uuid references shop.fittings_dealer_users(id) on delete set null,
  decided_name text not null default '',
  decided_at timestamptz
);
create unique index if not exists fittings_count_requests_one_open on shop.fittings_count_requests(location_id, product_id) where status = 'pending';

-- A signed-in person at the dealer that owns this location; raises otherwise.
create or replace function shop.fittings_dealer_person(p_user uuid, p_location uuid)
returns shop.fittings_dealer_users language plpgsql stable set search_path = shop, public, extensions as $$
declare u fittings_dealer_users;
begin
  select du.* into u from fittings_dealer_users du
    join fittings_locations l on l.dealer_id = du.dealer_id
    where du.id = p_user and l.id = p_location and not du.disabled;
  if u.id is null then raise exception 'not one of this dealer''s people'; end if;
  return u;
end; $$;

-- True when this order still needs its second check at this location.
create or replace function shop.fittings_ship_check_needed(p_order uuid, p_location uuid)
returns boolean language sql stable set search_path = shop, public, extensions as $$
  select coalesce((select d.ship_check <> 'off' from fittings_locations l join fittings_dealers d on d.id = l.dealer_id where l.id = p_location), false)
     and not exists (select 1 from fittings_ship_checks c where c.order_id = p_order and c.location_id = p_location and c.checked_at is not null);
$$;

-- "I packed it." Starts (or restarts) the wait for a second check.
create or replace function shop.fittings_ship_check_pack(p_order uuid, p_location uuid, p_user uuid)
returns void language plpgsql set search_path = shop, public, extensions as $$
declare u fittings_dealer_users;
begin
  u := fittings_dealer_person(p_user, p_location);
  if not exists (select 1 from fittings_allocations where order_id = p_order and location_id = p_location) then
    raise exception 'that location has no parts on this order';
  end if;
  if exists (select 1 from fittings_ship_checks where order_id = p_order and location_id = p_location and checked_at is not null) then
    raise exception 'already checked';
  end if;
  insert into fittings_ship_checks (order_id, location_id, packed_by, packed_name)
    values (p_order, p_location, u.id, coalesce(nullif(u.name, ''), u.email))
    on conflict (order_id, location_id) do update set packed_by = excluded.packed_by, packed_name = excluded.packed_name, packed_at = now();
  insert into fittings_dealer_events (dealer_id, user_id, user_name, role, action, order_id, location_id)
    values (u.dealer_id, u.id, coalesce(nullif(u.name, ''), u.email), u.role, 'packed', p_order, p_location);
end; $$;

-- "I checked it." The checker can't be the packer, and must be a manager when
-- the dealer asks for one. A manager who gives a reason can pass it anyway.
-- Returns 'checked' or 'override'.
create or replace function shop.fittings_ship_check_pass(p_order uuid, p_location uuid, p_user uuid, p_reason text)
returns text language plpgsql set search_path = shop, public, extensions as $$
declare
  u fittings_dealer_users;
  c fittings_ship_checks;
  v_mode text;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_how text;
begin
  u := fittings_dealer_person(p_user, p_location);
  select d.ship_check into v_mode from fittings_dealers d where d.id = u.dealer_id;
  select * into c from fittings_ship_checks where order_id = p_order and location_id = p_location for update;
  if c.order_id is null then raise exception 'not packed yet'; end if;
  if c.checked_at is not null then raise exception 'already checked'; end if;
  if v_reason <> '' then
    if u.role <> 'manager' then raise exception 'only a manager can override'; end if;
    if length(v_reason) < 5 then raise exception 'give a reason'; end if;
    v_how := 'override';
  else
    if c.packed_by = u.id then raise exception 'same person'; end if;
    if v_mode = 'manager' and u.role <> 'manager' then raise exception 'manager needed'; end if;
    v_how := 'checked';
  end if;
  update fittings_ship_checks set checked_by = u.id, checked_name = coalesce(nullif(u.name, ''), u.email), checked_at = now(),
    override_reason = left(v_reason, 300) where order_id = p_order and location_id = p_location;
  insert into fittings_dealer_events (dealer_id, user_id, user_name, role, action, order_id, location_id, detail)
    values (u.dealer_id, u.id, coalesce(nullif(u.name, ''), u.email), u.role, v_how, p_order, p_location,
            jsonb_build_object('packed_by', c.packed_name, 'reason', left(v_reason, 300)));
  return v_how;
end; $$;

-- The rule itself lives here: no shipment line is written for a dealer that
-- asks for a second check until the check is on record.
create or replace function shop.fittings_shipments_checked() returns trigger language plpgsql set search_path = shop, public, extensions as $$
begin
  if not exists (select 1 from fittings_shipments s where s.order_id = new.order_id and s.location_id = new.location_id)
     and fittings_ship_check_needed(new.order_id, new.location_id) then
    raise exception 'ship check needed';
  end if;
  return new;
end; $$;
drop trigger if exists fittings_shipments_checked on shop.fittings_shipments;
create trigger fittings_shipments_checked before insert on shop.fittings_shipments for each row execute function shop.fittings_shipments_checked();

-- A manager says yes or no to a held count. Yes sets the count, and the stock
-- history says who asked and who approved.
create or replace function shop.fittings_count_decide(p_id bigint, p_user uuid, p_approve boolean)
returns text language plpgsql set search_path = shop, public, extensions as $$
declare
  r fittings_count_requests;
  u fittings_dealer_users;
  v_name text;
begin
  select * into r from fittings_count_requests where id = p_id for update;
  if r.id is null then raise exception 'no such request'; end if;
  if r.status <> 'pending' then raise exception 'already decided'; end if;
  u := fittings_dealer_person(p_user, r.location_id);
  if u.role <> 'manager' then raise exception 'manager needed'; end if;
  v_name := coalesce(nullif(u.name, ''), u.email);
  if p_approve then
    perform fittings_import_counts(r.location_id, jsonb_build_array(jsonb_build_object('product_id', r.product_id, 'qty', r.to_qty, 'price_cents', null)),
                                   left('Count by ' || r.asked_name || ', approved by ' || v_name, 120));
  end if;
  update fittings_count_requests set status = case when p_approve then 'approved' else 'declined' end,
    decided_by = u.id, decided_name = v_name, decided_at = now() where id = p_id;
  insert into fittings_dealer_events (dealer_id, user_id, user_name, role, action, location_id, detail)
    values (u.dealer_id, u.id, v_name, u.role, case when p_approve then 'count_approved' else 'count_declined' end, r.location_id,
            jsonb_build_object('product_id', r.product_id, 'name', (select name from fittings_products where id = r.product_id),
                               'from', r.from_qty, 'to', r.to_qty, 'asked_by', r.asked_name));
  return case when p_approve then 'approved' else 'declined' end;
end; $$;

-- Access: the site's server only.
alter table shop.fittings_dealer_events enable row level security;
alter table shop.fittings_ship_checks enable row level security;
alter table shop.fittings_count_requests enable row level security;
revoke all on shop.fittings_dealer_events, shop.fittings_ship_checks, shop.fittings_count_requests from anon, authenticated;
grant select, insert on shop.fittings_dealer_events to service_role;
grant select, insert, update on shop.fittings_ship_checks, shop.fittings_count_requests to service_role;
revoke all on function shop.fittings_dealer_person(uuid, uuid) from public, anon, authenticated;
revoke all on function shop.fittings_ship_check_needed(uuid, uuid) from public, anon, authenticated;
revoke all on function shop.fittings_ship_check_pack(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function shop.fittings_ship_check_pass(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function shop.fittings_count_decide(bigint, uuid, boolean) from public, anon, authenticated;
grant execute on function shop.fittings_dealer_person(uuid, uuid) to service_role;
grant execute on function shop.fittings_ship_check_needed(uuid, uuid) to service_role;
grant execute on function shop.fittings_ship_check_pack(uuid, uuid, uuid) to service_role;
grant execute on function shop.fittings_ship_check_pass(uuid, uuid, uuid, text) to service_role;
grant execute on function shop.fittings_count_decide(bigint, uuid, boolean) to service_role;

notify pgrst, 'reload schema';
