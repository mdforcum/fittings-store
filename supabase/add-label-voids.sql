-- ---------------------------------------------------------------------------
-- Voiding a dealer's shipping label.
--
-- When a label bought on the dealer page was a mistake, staff void it: the
-- shipping account is asked for a refund, the dealer's statement gets a line
-- that gives the charge back, the shipment is taken off the order, and the
-- order goes back to "to ship". Every void is kept in its own record.
--
-- Needs add-dealer-labels.sql. Safe to run more than once.
-- ---------------------------------------------------------------------------

create table if not exists shop.fittings_label_voids (
  id bigint generated always as identity primary key,
  order_id uuid not null references shop.fittings_orders(id) on delete restrict,
  location_id uuid references shop.fittings_locations(id) on delete set null,
  shippo_transaction_id text not null,
  carrier text not null default '',
  tracking_number text not null default '',
  label_cost_cents integer,
  label_charge_cents integer,
  -- what the shipping account said when asked for the refund
  refund_status text not null default '',
  voided_by text not null default '',
  reason text not null default '',
  created_at timestamptz not null default now()
);
drop trigger if exists fittings_label_voids_frozen on shop.fittings_label_voids;
create trigger fittings_label_voids_frozen before update or delete on shop.fittings_label_voids
  for each row execute function shop.fittings_frozen();

-- Takes a bought label off an order. Returns what went back on the dealer's statement.
create or replace function shop.fittings_void_label(p_order_id uuid, p_location uuid, p_refund_status text, p_by text, p_reason text)
returns jsonb language plpgsql set search_path = shop, public, extensions as $$
declare
  sh record;
  v_dealer uuid;
  v_credit integer := 0;
begin
  select * into sh from fittings_shipments where order_id = p_order_id and location_id = p_location for update;
  if not found or sh.shippo_transaction_id is null then
    raise exception 'there is no bought label to void here';
  end if;
  insert into fittings_label_voids (order_id, location_id, shippo_transaction_id, carrier, tracking_number, label_cost_cents,
                                    label_charge_cents, refund_status, voided_by, reason)
  values (p_order_id, p_location, sh.shippo_transaction_id, sh.carrier, sh.tracking_number, sh.label_cost_cents,
          sh.label_charge_cents, left(coalesce(p_refund_status, ''), 20), left(coalesce(p_by, ''), 80), left(coalesce(p_reason, ''), 200));
  select dealer_id into v_dealer from fittings_locations where id = p_location;
  -- The dealer was charged for this label: give that back with its own line.
  if v_dealer is distinct from fittings_house_dealer() and coalesce(sh.label_charge_cents, 0) > 0 then
    v_credit := sh.label_charge_cents;
    insert into fittings_settlements (order_id, dealer_id, kind, parts_cents, shipping_cents, cut_bps, cut_cents,
                                      referral_cents, network_bps, network_cents, card_fee_cents, net_cents, reason)
    values (p_order_id, v_dealer, 'label', 0, v_credit, 0, 0, 0, 0, 0, 0, v_credit,
            left(trim('Label voided: ' || sh.carrier || ' ' || sh.tracking_number), 200));
  end if;
  delete from fittings_shipments where order_id = p_order_id and location_id = p_location;
  -- This location's parts still need to ship, so the order isn't finished.
  update fittings_orders set status = 'paid', shipped_at = null,
    carrier = case when tracking_number is not distinct from sh.tracking_number then null else carrier end,
    tracking_url = case when tracking_number is not distinct from sh.tracking_number then null else tracking_url end,
    tracking_number = case when tracking_number is not distinct from sh.tracking_number then null else tracking_number end
  where id = p_order_id and status = 'shipped';
  return jsonb_build_object('credit_cents', v_credit);
end; $$;

alter table shop.fittings_label_voids enable row level security;
revoke all on shop.fittings_label_voids from anon, authenticated;
grant select, insert on shop.fittings_label_voids to service_role;
revoke all on function shop.fittings_void_label(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function shop.fittings_void_label(uuid, uuid, text, text, text) to service_role;

notify pgrst, 'reload schema';
