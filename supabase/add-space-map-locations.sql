-- ---------------------------------------------------------------------------
-- Space maps belong to one location (2026-11-27). A map is the layout file of
-- one dealer location, so a dealer's staff see and change only their own, and
-- the file can only write under that location's own top spot on the shelf map.
--
-- fittings_space_maps
--   location_id   the store location this file maps; one file per location
--   created_by    who started it: a dealer login's email, or the back office
--   updated_by    who changed it last
--   reads_day,    how many photo reads this map has had today (a daily cap
--   reads_today   keeps one login from running up the reading bill)
-- fittings_space_photos
--   added_by      who added the photo
-- fittings_shelf_spots
--   location_id   on a top spot only: the store location it is the shelf map
--                 of. A layout file writes under its own location's top spot
--                 and nowhere else.
--
-- Needs add-space-maps.sql and add-locations.sql first. Safe to run more than
-- once. Maps made before this file have no location; there were none.
-- ---------------------------------------------------------------------------
alter table shop.fittings_space_maps
  add column if not exists location_id uuid references shop.fittings_locations(id) on delete restrict,
  add column if not exists created_by text not null default '' check (char_length(created_by) <= 200),
  add column if not exists updated_by text not null default '' check (char_length(updated_by) <= 200),
  add column if not exists reads_day date,
  add column if not exists reads_today integer not null default 0 check (reads_today >= 0);
create unique index if not exists fittings_space_maps_location_key on shop.fittings_space_maps(location_id);

alter table shop.fittings_space_photos
  add column if not exists added_by text not null default '' check (char_length(added_by) <= 200);

alter table shop.fittings_shelf_spots
  add column if not exists location_id uuid references shop.fittings_locations(id) on delete restrict;
create unique index if not exists fittings_shelf_spots_location_key
  on shop.fittings_shelf_spots(location_id) where location_id is not null;
do $$ begin
  alter table shop.fittings_shelf_spots add constraint fittings_shelf_spots_location_top_chk
    check (location_id is null or parent_id is null);
exception when duplicate_object then null; end $$;

-- A top spot already carrying a store location's code is that location's,
-- when exactly one location has the code.
update shop.fittings_shelf_spots s
   set location_id = l.id
  from shop.fittings_locations l
 where s.parent_id is null and s.location_id is null
   and l.kind = 'store' and l.code <> '' and l.code = s.code
   and (select count(*) from shop.fittings_locations x where x.kind = 'store' and x.code = l.code) = 1
   and not exists (select 1 from shop.fittings_shelf_spots t where t.location_id = l.id);
