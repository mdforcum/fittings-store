-- ---------------------------------------------------------------------------
-- Running the network day to day.
--
--   * Each store location has its own ship-from address; labels for parts
--     pulled there ship from it.
--   * Dealers have contact details for alerts, and their own logins.
--   * An outbox of alerts (email or text). Each message is kept whether or
--     not a provider is set up to send it.
--   * Shipments: each location that pulls parts for an order records its own
--     carrier and tracking. The order is shipped when every location has.
--   * Returns and cancellations: parts go back on the shelf they came from,
--     the refund is recorded, and the dealer ledger gets reversing lines.
--     Nothing already written is changed.
--   * Counter sales: a walk-in or phone sale at a location comes off that
--     location's count, with its own record.
--
-- Needs every earlier shop change. Safe to run more than once.
-- ---------------------------------------------------------------------------

-- Ship-from address per location -------------------------------------------------
alter table shop.fittings_locations
  add column if not exists street1 text not null default '',
  add column if not exists street2 text not null default '',
  add column if not exists phone text not null default '';

-- Dealer contacts and logins -------------------------------------------------------
alter table shop.fittings_dealers
  add column if not exists alert_email text not null default '',
  add column if not exists alert_phone text not null default '';

create table if not exists shop.fittings_dealer_users (
  id uuid primary key default gen_random_uuid(),
  dealer_id uuid not null references shop.fittings_dealers(id) on delete cascade,
  email text not null unique check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  name text not null default '',
  -- scrypt: "scrypt$<salt hex>$<hash hex>"
  password_hash text not null check (password_hash like 'scrypt$%'),
  disabled boolean not null default false,
  -- after repeated wrong passwords the login waits a while
  failed_logins integer not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

-- Alert outbox ------------------------------------------------------------------
create table if not exists shop.fittings_alerts (
  id bigint generated always as identity primary key,
  dealer_id uuid references shop.fittings_dealers(id) on delete set null,
  order_id uuid references shop.fittings_orders(id) on delete set null,
  topic text not null check (topic in ('routed_order', 'low_stock', 'other')),
  channel text not null check (channel in ('email', 'sms', 'portal')),
  send_to text not null default '',
  subject text not null default '',
  body text not null,
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed', 'not_sent')),
  error text not null default '',
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (order_id, dealer_id, channel, topic)
);
create index if not exists fittings_alerts_dealer_idx on shop.fittings_alerts(dealer_id, created_at desc);

-- Shipments ------------------------------------------------------------------------
create table if not exists shop.fittings_shipments (
  id bigint generated always as identity primary key,
  order_id uuid not null references shop.fittings_orders(id) on delete cascade,
  location_id uuid not null references shop.fittings_locations(id) on delete restrict,
  carrier text not null default '',
  tracking_number text not null default '',
  tracking_url text not null default '',
  shipped_by text not null default '',
  shipped_at timestamptz not null default now(),
  unique (order_id, location_id)
);

-- Records a location's shipment; marks the order shipped once every location
-- that pulled parts for it has shipped.
create or replace function shop.fittings_ship_from_location(p_order_id uuid, p_location uuid, p_carrier text, p_tracking text,
                                                            p_url text, p_by text)
returns boolean language plpgsql set search_path = shop, public, extensions as $$
declare v_left integer;
begin
  if not exists (select 1 from fittings_allocations where order_id = p_order_id and location_id = p_location) then
    raise exception 'that location has no parts on this order';
  end if;
  if not exists (select 1 from fittings_orders where id = p_order_id and status in ('paid', 'shipped')) then
    raise exception 'only a paid order can ship';
  end if;
  insert into fittings_shipments (order_id, location_id, carrier, tracking_number, tracking_url, shipped_by)
  values (p_order_id, p_location, left(coalesce(p_carrier, ''), 40), left(coalesce(p_tracking, ''), 80), left(coalesce(p_url, ''), 300), left(coalesce(p_by, ''), 80))
  on conflict (order_id, location_id) do update set carrier = excluded.carrier, tracking_number = excluded.tracking_number,
    tracking_url = excluded.tracking_url, shipped_by = excluded.shipped_by, shipped_at = now();
  select count(*) into v_left from (select distinct location_id from fittings_allocations where order_id = p_order_id) a
    where not exists (select 1 from fittings_shipments s where s.order_id = p_order_id and s.location_id = a.location_id);
  if v_left = 0 then
    update fittings_orders set status = 'shipped', shipped_at = coalesce(shipped_at, now()),
      carrier = coalesce(nullif(carrier, ''), left(p_carrier, 40)),
      tracking_number = coalesce(nullif(tracking_number, ''), left(p_tracking, 80)),
      tracking_url = coalesce(nullif(tracking_url, ''), left(p_url, 300))
    where id = p_order_id and status = 'paid';
  end if;
  return v_left = 0;
end; $$;

-- Returns, cancellations and ledger reversals -------------------------------------------
alter table shop.fittings_orders add column if not exists refunded_cents integer not null default 0 check (refunded_cents >= 0);

create table if not exists shop.fittings_returns (
  id bigint generated always as identity primary key,
  order_id uuid not null references shop.fittings_orders(id) on delete restrict,
  product_id text not null,
  location_id uuid references shop.fittings_locations(id) on delete set null,
  qty integer not null check (qty > 0),
  restocked boolean not null,
  reason text not null default '',
  created_at timestamptz not null default now()
);
create table if not exists shop.fittings_refunds (
  id bigint generated always as identity primary key,
  order_id uuid not null references shop.fittings_orders(id) on delete restrict,
  amount_cents integer not null check (amount_cents > 0),
  stripe_refund_id text,
  reason text not null default '',
  created_at timestamptz not null default now()
);
create or replace function shop.fittings_frozen() returns trigger language plpgsql set search_path = shop, public, extensions as $$
begin raise exception 'this record is kept as written'; end; $$;
drop trigger if exists fittings_returns_frozen on shop.fittings_returns;
create trigger fittings_returns_frozen before update or delete on shop.fittings_returns for each row execute function shop.fittings_frozen();
drop trigger if exists fittings_refunds_frozen on shop.fittings_refunds;
create trigger fittings_refunds_frozen before update or delete on shop.fittings_refunds for each row execute function shop.fittings_frozen();

-- Ledger: reversal lines sit beside the line they reverse.
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'fittings_settlements_pkey' and conrelid = 'shop.fittings_settlements'::regclass)
     and not exists (select 1 from information_schema.columns where table_schema = 'shop' and table_name = 'fittings_settlements' and column_name = 'id') then
    alter table shop.fittings_settlements drop constraint fittings_settlements_pkey;
    alter table shop.fittings_settlements add column id bigint generated always as identity primary key;
  end if;
end $$;
create unique index if not exists fittings_settlements_one_line on shop.fittings_settlements(order_id, dealer_id) where kind <> 'reversal';
-- The order's ledger writer names that index; this also works with the old key.
do $$ declare d text; begin
  select pg_get_functiondef('shop.fittings_settle_order(uuid)'::regprocedure) into d;
  if position('where kind <> ''reversal'' do nothing' in d) = 0 then
    execute replace(d, 'on conflict (order_id, dealer_id) do nothing', 'on conflict (order_id, dealer_id) where kind <> ''reversal'' do nothing');
  end if;
end $$;
alter table shop.fittings_settlements drop constraint if exists fittings_settlements_kind_check;
alter table shop.fittings_settlements add constraint fittings_settlements_kind_check
  check (kind in ('routed', 'storefront', 'referral', 'network', 'mixed', 'reversal'));
alter table shop.fittings_settlements add column if not exists reason text not null default '';
-- Reversal lines carry negative amounts; every other line stays zero or more.
alter table shop.fittings_settlements drop constraint if exists fittings_settlements_parts_cents_check;
alter table shop.fittings_settlements drop constraint if exists fittings_settlements_shipping_cents_check;
alter table shop.fittings_settlements drop constraint if exists fittings_settlements_cut_cents_check;
alter table shop.fittings_settlements drop constraint if exists fittings_settlements_referral_cents_check;
alter table shop.fittings_settlements drop constraint if exists fittings_settlements_network_cents_check;
alter table shop.fittings_settlements drop constraint if exists fittings_settlements_card_fee_cents_check;
do $$ begin
  alter table shop.fittings_settlements add constraint fittings_settlements_signs_chk check (
    case when kind = 'reversal'
      then parts_cents <= 0 and shipping_cents <= 0 and cut_cents <= 0 and referral_cents <= 0 and network_cents <= 0
      else parts_cents >= 0 and shipping_cents >= 0 and cut_cents >= 0 and referral_cents >= 0 and network_cents >= 0
           and (card_fee_cents is null or card_fee_cents >= 0) end);
exception when duplicate_object then null; end $$;

-- Parts come back (some or all of an order). Each part goes back to the
-- location it was pulled from (largest first), unless it can't be resold.
-- Every dealer whose sale or shipment is undone gets a reversing ledger line
-- at the rates on its original line. Stripe keeps its processing fee on a
-- refund, so a dealer's share of the card fee is not reversed. A dealer's
-- shipping credit comes back only when the whole order does and the shopper
-- got the shipping back too (p_restock_shipping).
drop function if exists shop.fittings_return_items(uuid, jsonb, boolean, text);
create or replace function shop.fittings_return_items(p_order_id uuid, p_items jsonb, p_restock boolean, p_reason text,
                                                       p_restock_shipping boolean default false)
returns jsonb language plpgsql set search_path = shop, public, extensions as $$
declare
  it record;
  a record;
  v_sold integer;
  v_back integer;
  v_left integer;
  v_take integer;
  v_unit integer;
  v_seller uuid;
  v_house uuid := fittings_house_dealer();
  v_by jsonb := '{}'::jsonb;  -- dealer id → parts value coming back from its shelves
  v_total integer := 0;
  s record;
  v_val integer;
  v_returned integer := 0;
  v_all_back boolean;
  v_order_parts integer;
  v_parts_left integer;
  v_ref_left integer;
  v_ship_left integer;
  v_ref integer;
  v_ship integer;
  v_cut integer;
  v_net integer;
begin
  if not exists (select 1 from fittings_orders where id = p_order_id and status in ('paid', 'shipped', 'cancelled')) then
    raise exception 'only a paid order can have returns';
  end if;
  select case when dealer_id is distinct from v_house then dealer_id end into v_seller from fittings_orders where id = p_order_id;
  perform set_config('shop.move_kind', 'return', true);
  perform set_config('shop.move_order', p_order_id::text, true);
  perform set_config('shop.move_note', left(coalesce(p_reason, ''), 200), true);

  for it in select x->>'product_id' as product_id, (x->>'qty')::integer as qty from jsonb_array_elements(p_items) x loop
    if it.qty is null or it.qty < 1 then raise exception 'return at least one'; end if;
    select coalesce(sum(qty), 0) into v_sold from fittings_order_items where order_id = p_order_id and product_id = it.product_id;
    select coalesce(sum(qty), 0) into v_back from fittings_returns where order_id = p_order_id and product_id = it.product_id;
    if it.qty > v_sold - v_back then
      raise exception 'only % of % can still come back', greatest(v_sold - v_back, 0), it.product_id;
    end if;
    select round(sum(unit_price_cents * qty)::numeric / nullif(sum(qty), 0))::integer into v_unit
      from fittings_order_items where order_id = p_order_id and product_id = it.product_id;
    v_left := it.qty;
    -- Back to the shelves it came from, the biggest share first, net of earlier returns there.
    for a in
      select al.location_id, l.dealer_id,
             al.qty - coalesce((select sum(r.qty) from fittings_returns r where r.order_id = p_order_id and r.product_id = it.product_id and r.location_id = al.location_id), 0) as open_qty
      from fittings_allocations al join fittings_locations l on l.id = al.location_id
      where al.order_id = p_order_id and al.product_id = it.product_id
      order by al.qty desc, al.location_id
    loop
      exit when v_left <= 0;
      continue when a.open_qty <= 0;
      v_take := least(a.open_qty, v_left);
      insert into fittings_returns (order_id, product_id, location_id, qty, restocked, reason)
        values (p_order_id, it.product_id, a.location_id, v_take, p_restock, left(coalesce(p_reason, ''), 200));
      if p_restock then
        insert into fittings_onhand (product_id, location_id, qty) values (it.product_id, a.location_id, v_take)
          on conflict (product_id, location_id) do update set qty = fittings_onhand.qty + excluded.qty, updated_at = now();
      end if;
      v_by := jsonb_set(v_by, array[a.dealer_id::text], to_jsonb(coalesce((v_by->>(a.dealer_id::text))::integer, 0) + v_take * coalesce(v_unit, 0)));
      v_total := v_total + v_take * coalesce(v_unit, 0);
      v_returned := v_returned + v_take;
      v_left := v_left - v_take;
    end loop;
    if v_left > 0 then
      -- Never pulled from a shelf (the order came up short): record it with no location.
      insert into fittings_returns (order_id, product_id, location_id, qty, restocked, reason)
        values (p_order_id, it.product_id, null, v_left, false, left(coalesce(p_reason, ''), 200));
      v_returned := v_returned + v_left;
    end if;
  end loop;
  perform set_config('shop.move_kind', '', true);
  perform set_config('shop.move_order', '', true);

  -- Reversing ledger lines, at each dealer's original rates. Nothing is
  -- written for a dealer this return doesn't touch.
  select not exists (
    select 1 from fittings_order_items i where i.order_id = p_order_id
    and i.qty > (select coalesce(sum(r.qty), 0) from fittings_returns r where r.order_id = p_order_id and r.product_id = i.product_id)
  ) into v_all_back;
  select coalesce(sum(unit_price_cents * qty), 0) into v_order_parts from fittings_order_items where order_id = p_order_id;
  for s in
    select * from fittings_settlements where order_id = p_order_id and kind <> 'reversal'
  loop
    v_val := coalesce((v_by->>(s.dealer_id::text))::integer, 0);
    -- what of this dealer's line is still standing after earlier returns
    select s.parts_cents + coalesce(sum(r.parts_cents), 0), s.referral_cents + coalesce(sum(r.referral_cents), 0),
           s.shipping_cents + coalesce(sum(r.shipping_cents), 0)
      into v_parts_left, v_ref_left, v_ship_left
      from fittings_settlements r where r.order_id = p_order_id and r.dealer_id = s.dealer_id and r.kind = 'reversal';
    v_val := least(v_val, v_parts_left);
    -- a seller's earned share comes back in step with the parts others shipped
    v_ref := 0;
    if s.dealer_id = v_seller and s.referral_cents > 0 and v_order_parts - s.parts_cents > 0 then
      v_ref := least(v_ref_left, round(s.referral_cents::numeric * (v_total - v_val) / (v_order_parts - s.parts_cents))::integer);
    end if;
    v_ship := case when v_all_back and p_restock_shipping then v_ship_left else 0 end;
    continue when v_val = 0 and v_ref = 0 and v_ship = 0;
    v_cut := round(v_val::numeric * s.cut_bps / 10000)::integer;
    v_net := round(v_val::numeric * s.network_bps / 10000)::integer;
    insert into fittings_settlements (order_id, dealer_id, kind, parts_cents, shipping_cents, cut_bps, cut_cents,
                                      referral_cents, network_bps, network_cents, card_fee_cents, net_cents, reason)
    values (p_order_id, s.dealer_id, 'reversal', -v_val, -v_ship, s.cut_bps, -v_cut, -v_ref, s.network_bps, -v_net,
            0, -v_val - v_ship - v_ref + v_cut + v_net, left(coalesce(p_reason, ''), 200));
  end loop;
  return jsonb_build_object('returned', v_returned, 'value_cents', v_total);
end; $$;

-- A refund made (or recorded) against an order.
create or replace function shop.fittings_record_refund(p_order_id uuid, p_amount integer, p_stripe_id text, p_reason text, p_cancel boolean)
returns void language plpgsql set search_path = shop, public, extensions as $$
declare v_paid integer; v_refunded integer;
begin
  -- What the card paid in all (parts, shipping, tax, cores), less core credits already refunded.
  select coalesce(total_cents, 0), refunded_cents into v_paid, v_refunded
    from fittings_orders where id = p_order_id for update;
  if not found then raise exception 'order not found'; end if;
  v_paid := v_paid - (select coalesce(sum(refunded_cents), 0) from fittings_order_charges where order_id = p_order_id);
  if p_amount is null or p_amount < 1 then raise exception 'refund at least 1 cent'; end if;
  if v_refunded + p_amount > v_paid then raise exception 'that is more than was paid'; end if;
  insert into fittings_refunds (order_id, amount_cents, stripe_refund_id, reason) values (p_order_id, p_amount, p_stripe_id, left(coalesce(p_reason, ''), 200));
  update fittings_orders set refunded_cents = refunded_cents + p_amount,
    status = case when p_cancel then 'cancelled' else status end
  where id = p_order_id;
end; $$;

-- Counter sales ------------------------------------------------------------------------
create table if not exists shop.fittings_counter_sales (
  id bigint generated always as identity primary key,
  location_id uuid not null references shop.fittings_locations(id) on delete restrict,
  lines jsonb not null,
  total_cents integer not null check (total_cents >= 0),
  paid_by text not null default '' check (paid_by in ('', 'cash', 'card', 'check', 'account')),
  note text not null default '',
  rung_by text not null default '',
  created_at timestamptz not null default now()
);
drop trigger if exists fittings_counter_sales_frozen on shop.fittings_counter_sales;
create trigger fittings_counter_sales_frozen before update or delete on shop.fittings_counter_sales for each row execute function shop.fittings_frozen();

-- Rings up a sale at a location: every line must be on that shelf, then it all
-- comes off together. Returns the sale's id.
create or replace function shop.fittings_counter_sale(p_location uuid, p_lines jsonb, p_paid_by text, p_note text, p_by text)
returns bigint language plpgsql set search_path = shop, public, extensions as $$
declare
  ln record;
  v_have integer;
  v_total integer := 0;
  v_id bigint;
  v_clean jsonb := '[]'::jsonb;
begin
  if not exists (select 1 from fittings_locations where id = p_location and kind = 'store') then
    raise exception 'pick a store location';
  end if;
  for ln in
    select x->>'product_id' as product_id, sum((x->>'qty')::integer)::integer as qty, max((x->>'price_cents')::integer) as price
    from jsonb_array_elements(p_lines) x group by x->>'product_id' order by 1
  loop
    if ln.qty is null or ln.qty < 1 then raise exception 'sell at least one'; end if;
    select qty into v_have from fittings_onhand where product_id = ln.product_id and location_id = p_location for update;
    if coalesce(v_have, 0) < ln.qty then
      raise exception 'only % of % on this shelf', coalesce(v_have, 0), ln.product_id;
    end if;
    v_total := v_total + ln.qty * greatest(coalesce(ln.price, 0), 0);
    v_clean := v_clean || jsonb_build_object('product_id', ln.product_id, 'qty', ln.qty, 'price_cents', greatest(coalesce(ln.price, 0), 0));
  end loop;
  if jsonb_array_length(v_clean) = 0 then raise exception 'add at least one part'; end if;
  insert into fittings_counter_sales (location_id, lines, total_cents, paid_by, note, rung_by)
    values (p_location, v_clean, v_total, coalesce(p_paid_by, ''), left(coalesce(p_note, ''), 200), left(coalesce(p_by, ''), 80))
    returning id into v_id;
  perform set_config('shop.move_kind', 'sale', true);
  perform set_config('shop.move_note', left('Counter sale #' || v_id || case when coalesce(p_note, '') <> '' then ': ' || p_note else '' end, 200), true);
  update fittings_onhand o set qty = o.qty - (l->>'qty')::integer, updated_at = now()
    from jsonb_array_elements(v_clean) l
    where o.product_id = l->>'product_id' and o.location_id = p_location;
  perform set_config('shop.move_kind', '', true);
  perform set_config('shop.move_note', '', true);
  return v_id;
end; $$;

-- Spreadsheet import ----------------------------------------------------------------------
-- Sets each listed item's count at one location (as a recount) and, when a
-- price is given, its price. Lines whose count already matches are left
-- alone. Returns how many counts changed.
create or replace function shop.fittings_import_counts(p_location uuid, p_lines jsonb, p_note text)
returns integer language plpgsql set search_path = shop, public, extensions as $$
declare ln record; v_now integer; v_changed integer := 0;
begin
  if not exists (select 1 from fittings_locations where id = p_location and kind = 'store') then
    raise exception 'pick a store location';
  end if;
  if jsonb_array_length(p_lines) > 2000 then raise exception 'import up to 2000 rows at a time'; end if;
  perform set_config('shop.move_kind', 'count', true);
  perform set_config('shop.move_note', left(coalesce(p_note, ''), 200), true);
  for ln in
    select x->>'product_id' as product_id, (x->>'qty')::integer as qty, (x->>'price_cents')::integer as price
    from jsonb_array_elements(p_lines) x
  loop
    if ln.qty is null or ln.qty < 0 then raise exception 'a count must be 0 or more (%)', ln.product_id; end if;
    if not exists (select 1 from fittings_products where id = ln.product_id) then raise exception 'no item %', ln.product_id; end if;
    if ln.price is not null and ln.price >= 0 then
      update fittings_products set price_cents = nullif(ln.price, 0), updated_at = now()
        where id = ln.product_id and price_cents is distinct from nullif(ln.price, 0);
    end if;
    select qty into v_now from fittings_onhand where product_id = ln.product_id and location_id = p_location;
    if v_now is distinct from ln.qty then
      insert into fittings_onhand (product_id, location_id, qty) values (ln.product_id, p_location, ln.qty)
        on conflict (product_id, location_id) do update set qty = excluded.qty, updated_at = now();
      v_changed := v_changed + 1;
    end if;
  end loop;
  perform set_config('shop.move_kind', '', true);
  perform set_config('shop.move_note', '', true);
  return v_changed;
end; $$;

-- Access -------------------------------------------------------------------------------
alter table shop.fittings_dealer_users enable row level security;
alter table shop.fittings_alerts enable row level security;
alter table shop.fittings_shipments enable row level security;
alter table shop.fittings_returns enable row level security;
alter table shop.fittings_refunds enable row level security;
alter table shop.fittings_counter_sales enable row level security;
revoke all on shop.fittings_dealer_users, shop.fittings_alerts, shop.fittings_shipments, shop.fittings_returns,
  shop.fittings_refunds, shop.fittings_counter_sales from anon, authenticated;
grant all on shop.fittings_dealer_users, shop.fittings_alerts, shop.fittings_shipments to service_role;
grant select, insert on shop.fittings_returns, shop.fittings_refunds, shop.fittings_counter_sales to service_role;

revoke all on function shop.fittings_ship_from_location(uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function shop.fittings_return_items(uuid, jsonb, boolean, text, boolean) from public, anon, authenticated;
revoke all on function shop.fittings_record_refund(uuid, integer, text, text, boolean) from public, anon, authenticated;
revoke all on function shop.fittings_counter_sale(uuid, jsonb, text, text, text) from public, anon, authenticated;
revoke all on function shop.fittings_import_counts(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function shop.fittings_ship_from_location(uuid, uuid, text, text, text, text) to service_role;
grant execute on function shop.fittings_return_items(uuid, jsonb, boolean, text, boolean) to service_role;
grant execute on function shop.fittings_record_refund(uuid, integer, text, text, boolean) to service_role;
grant execute on function shop.fittings_counter_sale(uuid, jsonb, text, text, text) to service_role;
grant execute on function shop.fittings_import_counts(uuid, jsonb, text) to service_role;

notify pgrst, 'reload schema';
