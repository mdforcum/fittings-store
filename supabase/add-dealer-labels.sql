-- ---------------------------------------------------------------------------
-- Dealer shipping labels.
--
-- A dealer can buy a label for its part of an order from the dealer page. The
-- label is bought on Backroad Iron's shipping account, so what the dealer is
-- charged goes on its statement as its own ledger line (kind 'label', a
-- negative amount). The markup on top of the label's cost is set in the back
-- office (private config key dealer_labels) and starts at zero.
--
-- Needs add-operations.sql. Safe to run more than once.
-- ---------------------------------------------------------------------------

alter table shop.fittings_shipments
  add column if not exists service text not null default '',
  add column if not exists shippo_transaction_id text,
  -- what the label cost Backroad Iron, and what the dealer was charged for it
  add column if not exists label_cost_cents integer check (label_cost_cents >= 0),
  add column if not exists label_charge_cents integer check (label_charge_cents >= 0);

-- Ledger: a 'label' line charges a dealer for a label. An order can have
-- several (one per location that ships).
alter table shop.fittings_settlements drop constraint if exists fittings_settlements_kind_check;
alter table shop.fittings_settlements add constraint fittings_settlements_kind_check
  check (kind in ('routed', 'storefront', 'referral', 'network', 'mixed', 'reversal', 'label'));
alter table shop.fittings_settlements drop constraint if exists fittings_settlements_signs_chk;
alter table shop.fittings_settlements add constraint fittings_settlements_signs_chk check (
  case when kind = 'reversal'
         then parts_cents <= 0 and shipping_cents <= 0 and cut_cents <= 0 and referral_cents <= 0 and network_cents <= 0
       when kind = 'label'
         then parts_cents = 0 and cut_cents = 0 and referral_cents = 0 and network_cents = 0
       else parts_cents >= 0 and shipping_cents >= 0 and cut_cents >= 0 and referral_cents >= 0 and network_cents >= 0
            and (card_fee_cents is null or card_fee_cents >= 0) end);

-- The order's ledger writer and the returns function skip label lines.
do $$ declare d text; begin
  select pg_get_functiondef('shop.fittings_settle_order(uuid)'::regprocedure) into d;
  if position('kind <> ''label'' do nothing' in d) = 0 then
    d := replace(d, 'on conflict (order_id, dealer_id) do nothing', 'on conflict (order_id, dealer_id) where kind <> ''reversal'' do nothing');
    execute replace(d, 'where kind <> ''reversal'' do nothing', 'where kind <> ''reversal'' and kind <> ''label'' do nothing');
  end if;
  select pg_get_functiondef('shop.fittings_return_items(uuid, jsonb, boolean, text, boolean)'::regprocedure) into d;
  if position('kind not in (''reversal'', ''label'')' in d) = 0 then
    execute replace(d, 'where order_id = p_order_id and kind <> ''reversal''', 'where order_id = p_order_id and kind not in (''reversal'', ''label'')');
  end if;
end $$;
-- One sale line per dealer per order; reversal and label lines sit beside it.
do $$ begin
  if position('label' in coalesce((select indexdef from pg_indexes where schemaname = 'shop' and indexname = 'fittings_settlements_one_line'), '')) = 0 then
    drop index if exists shop.fittings_settlements_one_line;
    create unique index fittings_settlements_one_line on shop.fittings_settlements(order_id, dealer_id)
      where kind <> 'reversal' and kind <> 'label';
  end if;
end $$;

-- Records a label a dealer bought for its location's part of an order: the
-- shipment (which can finish the order), the label's cost and charge, and the
-- dealer's ledger line. All or nothing.
create or replace function shop.fittings_dealer_label(p_order_id uuid, p_location uuid, p_carrier text, p_service text,
                                                      p_tracking text, p_url text, p_transaction text,
                                                      p_cost integer, p_charge integer, p_by text)
returns jsonb language plpgsql set search_path = shop, public, extensions as $$
declare
  v_dealer uuid;
  v_done boolean;
begin
  if p_cost is null or p_cost < 0 or p_charge is null or p_charge < p_cost then
    raise exception 'the label charge can''t be less than its cost';
  end if;
  if coalesce(p_transaction, '') = '' then raise exception 'label reference missing'; end if;
  select dealer_id into v_dealer from fittings_locations where id = p_location and kind = 'store';
  if v_dealer is null then raise exception 'location not found'; end if;
  if exists (select 1 from fittings_shipments where order_id = p_order_id and location_id = p_location and shippo_transaction_id is not null) then
    raise exception 'this location already has a label for this order';
  end if;
  v_done := fittings_ship_from_location(p_order_id, p_location, p_carrier, p_tracking, p_url, p_by);
  update fittings_shipments set service = left(coalesce(p_service, ''), 60), shippo_transaction_id = p_transaction,
    label_cost_cents = p_cost, label_charge_cents = p_charge
  where order_id = p_order_id and location_id = p_location;
  -- Backroad Iron's own locations pay the shipping account directly: no ledger line.
  if v_dealer is distinct from fittings_house_dealer() then
    insert into fittings_settlements (order_id, dealer_id, kind, parts_cents, shipping_cents, cut_bps, cut_cents,
                                      referral_cents, network_bps, network_cents, card_fee_cents, net_cents, reason)
    values (p_order_id, v_dealer, 'label', 0, -p_charge, 0, 0, 0, 0, 0, 0, -p_charge,
            left(trim('Label: ' || coalesce(p_carrier, '') || ' ' || coalesce(p_service, '') || ' ' || coalesce(p_tracking, '')), 200));
  end if;
  return jsonb_build_object('shipped', v_done, 'charge_cents', p_charge);
end; $$;

revoke all on function shop.fittings_dealer_label(uuid, uuid, text, text, text, text, text, integer, integer, text) from public, anon, authenticated;
grant execute on function shop.fittings_dealer_label(uuid, uuid, text, text, text, text, text, integer, integer, text) to service_role;

notify pgrst, 'reload schema';
