-- The 20 items from the ADK600 cap and plug kit. Quantity starts at 0 and price
-- is empty, so every item shows as temporarily out of stock until counted and priced.
insert into public.fittings_products (id, name, type, size, dash, thread, part_number, description, sort) values
  ('721-fso-08', 'O-Ring Plug 1/2 ORB', 'orb-plug', '1/2', '-08', '3/4-16', '721-FSO-08', 'Male O-ring boss plug with hex head. Closes off an SAE straight-thread port.', 10),
  ('721-fso-10', 'O-Ring Plug 5/8 ORB', 'orb-plug', '5/8', '-10', '7/8-14', '721-FSO-10', 'Male O-ring boss plug with hex head. Closes off an SAE straight-thread port.', 20),
  ('721-fso-12', 'O-Ring Plug 3/4 ORB', 'orb-plug', '3/4', '-12', '1 1/16-12', '721-FSO-12', 'Male O-ring boss plug with hex head. Closes off an SAE straight-thread port.', 30),
  ('830-fs-04', '37° JIC Cap 1/4 FJ', 'jic-cap', '1/4', '-04', '7/16-20', '830-FS-04', 'Female 37° flare cap. Closes off a male JIC fitting or tube end.', 40),
  ('830-fs-05', '37° JIC Cap 5/16 FJ', 'jic-cap', '5/16', '-05', '1/2-20', '830-FS-05', 'Female 37° flare cap. Closes off a male JIC fitting or tube end.', 50),
  ('830-fs-06', '37° JIC Cap 3/8 FJ', 'jic-cap', '3/8', '-06', '9/16-18', '830-FS-06', 'Female 37° flare cap. Closes off a male JIC fitting or tube end.', 60),
  ('830-fs-08', '37° JIC Cap 1/2 FJ', 'jic-cap', '1/2', '-08', '3/4-16', '830-FS-08', 'Female 37° flare cap. Closes off a male JIC fitting or tube end.', 70),
  ('830-fs-10', '37° JIC Cap 5/8 FJ', 'jic-cap', '5/8', '-10', '7/8-14', '830-FS-10', 'Female 37° flare cap. Closes off a male JIC fitting or tube end.', 80),
  ('830-fs-12', '37° JIC Cap 3/4 FJ', 'jic-cap', '3/4', '-12', '1 1/16-12', '830-FS-12', 'Female 37° flare cap. Closes off a male JIC fitting or tube end.', 90),
  ('830-fs-16', '37° JIC Cap 1 FJ', 'jic-cap', '1', '-16', '1 5/16-12', '830-FS-16', 'Female 37° flare cap. Closes off a male JIC fitting or tube end.', 100),
  ('839-fs-04', '37° JIC Plug 1/4 MJ', 'jic-plug', '1/4', '-04', '7/16-20', '839-FS-04', 'Male 37° flare plug. Closes off a female JIC swivel or hose end.', 110),
  ('839-fs-05', '37° JIC Plug 5/16 MJ', 'jic-plug', '5/16', '-05', '1/2-20', '839-FS-05', 'Male 37° flare plug. Closes off a female JIC swivel or hose end.', 120),
  ('839-fs-06', '37° JIC Plug 3/8 MJ', 'jic-plug', '3/8', '-06', '9/16-18', '839-FS-06', 'Male 37° flare plug. Closes off a female JIC swivel or hose end.', 130),
  ('839-fs-08', '37° JIC Plug 1/2 MJ', 'jic-plug', '1/2', '-08', '3/4-16', '839-FS-08', 'Male 37° flare plug. Closes off a female JIC swivel or hose end.', 140),
  ('839-fs-10', '37° JIC Plug 5/8 MJ', 'jic-plug', '5/8', '-10', '7/8-14', '839-FS-10', 'Male 37° flare plug. Closes off a female JIC swivel or hose end.', 150),
  ('839-fs-12', '37° JIC Plug 3/4 MJ', 'jic-plug', '3/4', '-12', '1 1/16-12', '839-FS-12', 'Male 37° flare plug. Closes off a female JIC swivel or hose end.', 160),
  ('839-fs-14', '37° JIC Plug 7/8 MJ', 'jic-plug', '7/8', '-14', '1 3/16-12', '839-FS-14', 'Male 37° flare plug. Closes off a female JIC swivel or hose end.', 170),
  ('839-fs-16', '37° JIC Plug 1 MJ', 'jic-plug', '1', '-16', '1 5/16-12', '839-FS-16', 'Male 37° flare plug. Closes off a female JIC swivel or hose end.', 180),
  ('1c2216', 'Breather Plug 3/8 MP', 'breather-plug', '3/8', '', '3/8-18 pipe', '1C2216', 'Male pipe thread breather plug for a vented port.', 190),
  ('1c1235', 'Breather Plug 1/2 MP', 'breather-plug', '1/2', '', '1/2-14 pipe', '1C1235', 'Male pipe thread breather plug for a vented port.', 200)
on conflict (id) do nothing;
