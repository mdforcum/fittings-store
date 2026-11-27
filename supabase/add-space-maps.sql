-- ---------------------------------------------------------------------------
-- Space maps (2026-11-27): a shop's layout as one plain-text file, drafted
-- from photos and notes by the Space mapper tab (lib/spacemap.ts,
-- lib/spacemap-read.ts). Putting a file on the shelf map makes its spots in
-- fittings_shelf_spots; pick tickets then use the file's start point, links
-- and dead ends to order the walk (lib/walk.ts), reading applied_markup.
--
-- markup          the file as it stands (the reader's draft, or hand edits)
-- notes           what the person wrote about the shop as a whole
-- qa              the reader's questions and the person's answers
-- reading         what the reader understood last time: summary, what each
--                 photo showed, what it guessed
-- applied_markup  the file as last put on the shelf map; null applied_at
--                 means it never was
--
-- Photos live in the private bucket under spacemap/<map id>/.
-- Needs add-shelf-spots.sql first. Safe to run more than once.
-- ---------------------------------------------------------------------------
create table if not exists shop.fittings_space_maps (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  notes text not null default '' check (char_length(notes) <= 4000),
  markup text not null default '' check (char_length(markup) <= 200000),
  qa jsonb not null default '[]'::jsonb,
  reading jsonb not null default '{}'::jsonb,
  applied_markup text not null default '' check (char_length(applied_markup) <= 200000),
  applied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists shop.fittings_space_photos (
  id uuid primary key,
  map_id uuid not null references shop.fittings_space_maps(id) on delete cascade,
  path text not null check (char_length(path) between 1 and 200),
  note text not null default '' check (char_length(note) <= 400),
  created_at timestamptz not null default now()
);
create index if not exists fittings_space_photos_map_idx on shop.fittings_space_photos(map_id, created_at);

-- Back office only: no policies, so the publishable key reads nothing.
alter table shop.fittings_space_maps enable row level security;
alter table shop.fittings_space_photos enable row level security;
revoke all on shop.fittings_space_maps, shop.fittings_space_photos from anon, authenticated;
grant all on shop.fittings_space_maps, shop.fittings_space_photos to service_role;
