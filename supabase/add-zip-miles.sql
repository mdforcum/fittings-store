-- ---------------------------------------------------------------------------
-- Real mileage for "nearest".
--
-- When a Backroad Iron order is routed, the location that fills it was picked
-- by "same first three ZIP digits, then same state". This adds a table of ZIP
-- code centers so nearest means the shortest straight-line distance in miles.
-- The table is filled from the back office (Settings, Dealers and locations,
-- Real mileage) from the open-source "zipcodes" package. Until it is filled,
-- or for a ZIP that isn't in it, the old rule still applies.
--
-- Needs add-routing.sql. Safe to run more than once.
-- ---------------------------------------------------------------------------

create table if not exists shop.fittings_zip_points (
  zip text primary key check (zip ~ '^\d{5}$'),
  lat real not null check (lat between -90 and 90),
  lng real not null check (lng between -180 and 180)
);

-- Straight-line miles between two ZIP codes; null when either isn't known.
create or replace function shop.fittings_miles(p_a text, p_b text)
returns numeric language sql stable set search_path = shop, public, extensions as $$
  select round((3958.8 * 2 * asin(least(1, sqrt(
           power(sin(radians(b.lat - a.lat) / 2), 2)
           + cos(radians(a.lat)) * cos(radians(b.lat)) * power(sin(radians(b.lng - a.lng) / 2), 2)))))::numeric, 1)
  from fittings_zip_points a, fittings_zip_points b
  where a.zip = left(coalesce(p_a, ''), 5) and b.zip = left(coalesce(p_b, ''), 5);
$$;

-- Higher is nearer. With both ZIP codes known: a million less the miles, so
-- any measured distance outranks the rough rule. Otherwise the rough rule:
-- same first three ZIP digits (2), same state (1), anywhere else (0).
create or replace function shop.fittings_nearness(p_location uuid, p_zip text, p_state text)
returns integer language sql stable set search_path = shop, public, extensions as $$
  select coalesce(
    1000000 - round(fittings_miles(l.zip, p_zip))::integer,
    case
      when coalesce(p_zip, '') ~ '^\d{3}' and left(l.zip, 3) = left(p_zip, 3) then 2
      when coalesce(p_state, '') <> '' and upper(l.state) = upper(p_state) then 1
      else 0 end)
  from fittings_locations l where l.id = p_location;
$$;

alter table shop.fittings_zip_points enable row level security;
revoke all on shop.fittings_zip_points from anon, authenticated;
grant select, insert, update on shop.fittings_zip_points to service_role;
revoke all on function shop.fittings_miles(text, text) from public, anon, authenticated;
grant execute on function shop.fittings_miles(text, text) to service_role;
revoke all on function shop.fittings_nearness(uuid, text, text) from public;
grant execute on function shop.fittings_nearness(uuid, text, text) to service_role;

notify pgrst, 'reload schema';
