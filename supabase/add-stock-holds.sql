-- ---------------------------------------------------------------------------
-- Stock history and checkout holds.
--
-- fittings_products.qty stays the count on our shelf. Every change to it now
-- also writes a row to fittings_stock_moves (a trigger does it, so no path can
-- skip it). Rows there are never edited or deleted.
--
-- When a shopper starts checkout, the parts in the cart are held for them for
-- settings.hold_minutes (Stripe's checkout page closes at the same moment).
-- Other shoppers see qty minus what is held. Paying turns the hold into a sale
-- in the same transaction that takes the parts off the shelf count. A hold
-- that runs out simply stops counting; it is marked expired on the next pass.
--
-- Safe to run more than once.
-- ---------------------------------------------------------------------------

alter table shop.fittings_settings
  add column if not exists hold_minutes integer not null default 30,
  add column if not exists hold_grace_minutes integer not null default 5;
do $$ begin
  -- Stripe checkout pages last 30 minutes to 24 hours.
  alter table shop.fittings_settings add constraint fittings_settings_hold_chk
    check (hold_minutes between 30 and 1440 and hold_grace_minutes between 0 and 60);
exception when duplicate_object then null; end $$;

-- Stock history -------------------------------------------------------------

create table if not exists shop.fittings_stock_moves (
  id bigint generated always as identity primary key,
  product_id text not null,          -- no foreign key: history outlives the item
  delta integer not null,
  qty_after integer not null,
  kind text not null check (kind in ('start','receive','count','adjust','edit','sale','return')),
  order_id uuid,
  note text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists fittings_stock_moves_product_idx on shop.fittings_stock_moves(product_id, id desc);

create or replace function shop.fittings_stock_moves_frozen()
returns trigger language plpgsql set search_path = shop, public, extensions as $$
begin
  raise exception 'stock history cannot be changed';
end; $$;
drop trigger if exists fittings_stock_moves_frozen on shop.fittings_stock_moves;
create trigger fittings_stock_moves_frozen before update or delete on shop.fittings_stock_moves
  for each row execute function shop.fittings_stock_moves_frozen();

-- Writes the history row for any change to qty. A function that knows why
-- (a sale, a received shipment) says so with set_config('shop.move_kind', ...).
create or replace function shop.fittings_log_stock()
returns trigger language plpgsql set search_path = shop, public, extensions as $$
declare
  v_old integer := case when tg_op = 'INSERT' then 0 else old.qty end;
  v_kind text := nullif(current_setting('shop.move_kind', true), '');
  v_order text := nullif(current_setting('shop.move_order', true), '');
begin
  if new.qty is distinct from v_old then
    insert into fittings_stock_moves (product_id, delta, qty_after, kind, order_id, note)
    values (new.id, new.qty - v_old, new.qty,
            coalesce(v_kind, case when tg_op = 'INSERT' then 'start' else 'edit' end),
            v_order::uuid,
            coalesce(current_setting('shop.move_note', true), ''));
  end if;
  return new;
end; $$;
drop trigger if exists fittings_log_stock on shop.fittings_products;
create trigger fittings_log_stock after insert or update of qty on shop.fittings_products
  for each row execute function shop.fittings_log_stock();

-- Checkout holds ------------------------------------------------------------

create table if not exists shop.fittings_holds (
  id bigint generated always as identity primary key,
  order_id uuid not null references shop.fittings_orders(id) on delete cascade,
  product_id text not null references shop.fittings_products(id) on delete cascade,
  qty integer not null check (qty > 0),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz,
  end_reason text check (end_reason in ('sold','expired','released','cancelled')),
  check ((ended_at is null) = (end_reason is null))
);
create index if not exists fittings_holds_open_idx on shop.fittings_holds(product_id) where ended_at is null;
create index if not exists fittings_holds_order_idx on shop.fittings_holds(order_id);

-- A hold is written once and ended once. Nothing else about it changes.
create or replace function shop.fittings_holds_guard()
returns trigger language plpgsql set search_path = shop, public, extensions as $$
begin
  if old.ended_at is not null then
    raise exception 'this hold has already ended';
  end if;
  if (new.order_id, new.product_id, new.qty, new.created_at, new.expires_at)
     is distinct from (old.order_id, old.product_id, old.qty, old.created_at, old.expires_at) then
    raise exception 'a hold can only be ended';
  end if;
  return new;
end; $$;
drop trigger if exists fittings_holds_guard on shop.fittings_holds;
create trigger fittings_holds_guard before update on shop.fittings_holds
  for each row execute function shop.fittings_holds_guard();

-- Holds every item on a pending order, or nothing. Items are locked in id
-- order so two checkouts racing for the same parts queue instead of both
-- winning. Returns {ok, expires_at} or {ok:false, problems:[{id, available}]}.
create or replace function shop.fittings_hold_order(p_order_id uuid, p_minutes integer)
returns jsonb language plpgsql set search_path = shop, public, extensions as $$
declare
  r record;
  v_have integer;
  v_held integer;
  v_problems jsonb := '[]'::jsonb;
  v_until timestamptz := now() + make_interval(mins => p_minutes);
begin
  if p_minutes is null or p_minutes < 1 or p_minutes > 1500 then
    raise exception 'hold minutes out of range';
  end if;
  if not exists (select 1 from fittings_orders where id = p_order_id and status = 'pending') then
    return jsonb_build_object('ok', false, 'problems', '[]'::jsonb, 'reason', 'not_pending');
  end if;

  update fittings_holds set ended_at = now(), end_reason = 'expired'
    where ended_at is null and expires_at <= now();

  for r in
    select product_id, sum(qty)::integer as qty
    from fittings_order_items where order_id = p_order_id
    group by product_id order by product_id
  loop
    select qty into v_have from fittings_products where id = r.product_id for update;
    select coalesce(sum(qty), 0) into v_held from fittings_holds
      where product_id = r.product_id and ended_at is null and expires_at > now()
        and order_id <> p_order_id;
    if v_have is null or v_have - v_held < r.qty then
      v_problems := v_problems || jsonb_build_object('id', r.product_id,
        'available', greatest(coalesce(v_have, 0) - v_held, 0));
    end if;
  end loop;

  if jsonb_array_length(v_problems) > 0 then
    return jsonb_build_object('ok', false, 'problems', v_problems);
  end if;

  -- Holding again (the shopper came back to the same checkout) starts the
  -- clock over rather than stacking a second hold.
  update fittings_holds set ended_at = now(), end_reason = 'released'
    where order_id = p_order_id and ended_at is null;
  insert into fittings_holds (order_id, product_id, qty, expires_at)
  select p_order_id, product_id, sum(qty)::integer, v_until
    from fittings_order_items where order_id = p_order_id group by product_id;
  return jsonb_build_object('ok', true, 'expires_at', v_until);
end; $$;

-- Ends an order's open holds. Used when the shopper changes the cart and
-- starts over, when Stripe closes the checkout page, and when staff cancel.
create or replace function shop.fittings_release_holds(p_order_id uuid, p_reason text)
returns integer language plpgsql set search_path = shop, public, extensions as $$
declare n integer;
begin
  if p_reason not in ('expired','released','cancelled') then
    raise exception 'unknown reason';
  end if;
  update fittings_holds set ended_at = now(), end_reason = p_reason
    where order_id = p_order_id and ended_at is null;
  get diagnostics n = row_count;
  return n;
end; $$;

-- What shoppers cannot buy right now because it is in someone's checkout.
-- Totals only: no order, no shopper, no times.
create or replace function shop.fittings_held()
returns table (product_id text, held integer)
language sql stable security definer set search_path = shop, public, extensions as $$
  select product_id, sum(qty)::integer
  from fittings_holds
  where ended_at is null and expires_at > now()
  group by product_id;
$$;

-- Paying: mark the order paid, end its holds as sold, take the parts off the
-- shelf count (logged as a sale on this order), all or nothing. Safe to call
-- twice: the second call finds no pending order and returns false.
create or replace function shop.fittings_fulfill_order(p_order_id uuid, p_details jsonb)
returns boolean
language plpgsql
set search_path = shop, public, extensions
as $$
declare
  v_short boolean := false;
  v_have integer;
  r record;
begin
  update fittings_orders set
    status = 'paid',
    paid_at = now(),
    stripe_session_id = coalesce(p_details->>'stripe_session_id', stripe_session_id),
    stripe_payment_intent = p_details->>'stripe_payment_intent',
    email = p_details->>'email',
    customer_name = p_details->>'customer_name',
    phone = p_details->>'phone',
    ship_to = p_details->'ship_to',
    subtotal_cents = coalesce((p_details->>'subtotal_cents')::integer, subtotal_cents),
    shipping_cents = coalesce((p_details->>'shipping_cents')::integer, shipping_cents),
    tax_cents = coalesce((p_details->>'tax_cents')::integer, 0),
    total_cents = coalesce((p_details->>'total_cents')::integer, total_cents)
  where id = p_order_id and status in ('pending', 'expired');
  if not found then
    return false;
  end if;

  perform set_config('shop.move_kind', 'sale', true);
  perform set_config('shop.move_order', p_order_id::text, true);
  perform set_config('shop.move_note', '', true);

  for r in
    select product_id, sum(qty)::integer as qty from fittings_order_items
    where order_id = p_order_id group by product_id order by product_id
  loop
    select qty into v_have from fittings_products where id = r.product_id for update;
    if v_have is null or v_have < r.qty then
      v_short := true;
    end if;
    update fittings_products
      set qty = greatest(qty - r.qty, 0), updated_at = now()
      where id = r.product_id;
  end loop;

  update fittings_holds set ended_at = now(), end_reason = 'sold'
    where order_id = p_order_id and ended_at is null;

  perform set_config('shop.move_kind', '', true);
  perform set_config('shop.move_order', '', true);

  if v_short then
    update fittings_orders set stock_short = true where id = p_order_id;
  end if;
  return true;
end;
$$;

-- Adds or subtracts stock without a read-then-write race against sales,
-- saying why: receive (a shipment came in), count (a recount), return, adjust.
drop function if exists shop.fittings_adjust_qty(text, integer);
create or replace function shop.fittings_adjust_qty(p_id text, p_delta integer, p_kind text default 'adjust', p_note text default '')
returns integer
language plpgsql
set search_path = shop, public, extensions
as $$
declare v integer;
begin
  if p_kind not in ('receive','count','adjust','return') then
    raise exception 'unknown stock change';
  end if;
  perform set_config('shop.move_kind', p_kind, true);
  perform set_config('shop.move_note', left(coalesce(p_note, ''), 200), true);
  update fittings_products
    set qty = greatest(qty + p_delta, 0), updated_at = now()
    where id = p_id
  returning qty into v;
  perform set_config('shop.move_kind', '', true);
  perform set_config('shop.move_note', '', true);
  return v;
end;
$$;

-- A recount: sets the shelf count to what staff counted, logged as a count.
create or replace function shop.fittings_count_qty(p_id text, p_qty integer, p_note text default '')
returns integer
language plpgsql
set search_path = shop, public, extensions
as $$
declare v integer;
begin
  if p_qty is null or p_qty < 0 then
    raise exception 'a count must be 0 or more';
  end if;
  perform set_config('shop.move_kind', 'count', true);
  perform set_config('shop.move_note', left(coalesce(p_note, ''), 200), true);
  update fittings_products set qty = p_qty, updated_at = now() where id = p_id returning qty into v;
  perform set_config('shop.move_kind', '', true);
  perform set_config('shop.move_note', '', true);
  return v;
end;
$$;

alter table shop.fittings_stock_moves enable row level security;
alter table shop.fittings_holds enable row level security;
revoke all on shop.fittings_stock_moves, shop.fittings_holds from anon, authenticated;
grant select, insert on shop.fittings_stock_moves to service_role;
grant select, insert, update on shop.fittings_holds to service_role;

revoke all on function shop.fittings_hold_order(uuid, integer) from public, anon, authenticated;
revoke all on function shop.fittings_release_holds(uuid, text) from public, anon, authenticated;
revoke all on function shop.fittings_fulfill_order(uuid, jsonb) from public, anon, authenticated;
revoke all on function shop.fittings_adjust_qty(text, integer, text, text) from public, anon, authenticated;
revoke all on function shop.fittings_count_qty(text, integer, text) from public, anon, authenticated;
revoke all on function shop.fittings_held() from public;
grant execute on function shop.fittings_hold_order(uuid, integer) to service_role;
grant execute on function shop.fittings_release_holds(uuid, text) to service_role;
grant execute on function shop.fittings_fulfill_order(uuid, jsonb) to service_role;
grant execute on function shop.fittings_adjust_qty(text, integer, text, text) to service_role;
grant execute on function shop.fittings_count_qty(text, integer, text) to service_role;
grant execute on function shop.fittings_held() to anon, authenticated, service_role;

-- Starting point: one history row per item with what is on the shelf today.
insert into shop.fittings_stock_moves (product_id, delta, qty_after, kind, note)
select p.id, p.qty, p.qty, 'start', 'Count when stock history began'
from shop.fittings_products p
where not exists (select 1 from shop.fittings_stock_moves m where m.product_id = p.id);

notify pgrst, 'reload schema';
