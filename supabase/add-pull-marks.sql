-- ---------------------------------------------------------------------------
-- Saved check-offs for a dealer pulling an order.
--
-- On the dealer page each part on an order is checked off as it is pulled:
-- by scanning it or by tapping it. Until now those ticks lived only on the
-- one phone. This table keeps them, with who pulled what, so a second person
-- (or the same person after a reload) sees how far the order has got, and
-- Home can tell "still to pull" from "pulled, ready to pack".
--
-- One line per order, location and part: a part split across two locations
-- is pulled at each. Needs add-operations.sql. Safe to run more than once.
-- ---------------------------------------------------------------------------

create table if not exists shop.fittings_pull_marks (
  order_id uuid not null references shop.fittings_orders(id) on delete cascade,
  location_id uuid not null references shop.fittings_locations(id) on delete cascade,
  product_id text not null,
  picked_qty integer not null default 0 check (picked_qty between 0 and 100000),
  picked_by uuid references shop.fittings_dealer_users(id) on delete set null,
  picked_name text not null default '',
  picked_at timestamptz not null default now(),
  primary key (order_id, location_id, product_id)
);

alter table shop.fittings_pull_marks enable row level security;
revoke all on shop.fittings_pull_marks from anon, authenticated;
grant select, insert, update on shop.fittings_pull_marks to service_role;

notify pgrst, 'reload schema';
