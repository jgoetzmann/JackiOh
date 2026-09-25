-- Saved decks and trios (migration 0007), queue and room modes (0008) and the Best-of-3 series
-- (0009), as the server (postgres/service_role) drives them. Runs last, after
-- 01_schema_invariants.sql, 02_rls_as_client.sql and 03_match_lifecycle.sql, which left profiles
-- 1, 2 and 3 active, and after 03b_legacy_loadout_seed.sql, which saved profile 4's loadout
-- BEFORE migration 0007 ran so that 0007 had one to convert.
\set ON_ERROR_STOP on

-- Same rules as 01-03 (see 03's header for why each one exists):
--
--   * a check FAILS LOUDLY: every heading's assertion is a `do $$ ... raise exception
--     'FAIL (Rnnn): ...' $$` block, never a printed row a human has to read;
--   * a `when others` handler is never the proof: every expected refusal is matched on its
--     exact message prefix, or on the constraint name read with GET STACKED DIAGNOSTICS;
--   * a check that could be trivially true carries a vacuity guard (a successful control
--     before each refusal, rows to find before a lookup).
--
-- Each SPEC §11 row this file proves is named in a `### Rnnn: … ###` heading, which is how the
-- §11 index (packages/engine/test/rulings.test.ts) credits an SQL file. What a CLIENT may do
-- with the new tables — read its own decks and trios, read no series, write nothing, call
-- neither upsert — is 02_rls_as_client.sql's CHECKs 1-4, beside every other table's.
--
-- Everything written from R250 on stays inside this file's own transactions or is rolled back,
-- except the decks and trios R250 and R252 save for profiles 1 and 2, which nothing after them
-- reads.

\echo '### R254: every loadout became three named decks and My trio, and the loadout stayed ###'
do $$
declare
  legacy   constant uuid := '44444444-4444-4444-4444-444444444444';
  p1       constant uuid := '11111111-1111-1111-1111-111111111111';
  v_names  text[];
  v_ids    uuid[];
  v_trio   record;
  v_loaded timestamptz;
  v_deck   record;
  v_want   jsonb;
  n        bigint;
  v_slot   int;
begin
  -- The legacy tables stay where they are (R254: "The loadout tables stay where they are, no
  -- longer read or written, so nothing a player saved is lost"). Also the vacuity guard: without
  -- 03b's loadout there was nothing for 0007 to convert.
  select updated_at into v_loaded from public.loadouts
   where profile_id = legacy and catalog_version = 'core-0';
  if not found then
    raise exception 'FAIL (R254): profile 4 has no core-0 loadout — 03b did not run, or 0007 removed it';
  end if;
  select array_agg(name order by slot) into v_names from public.loadout_decks where profile_id = legacy;
  if v_names is distinct from array['Aggro', 'Control', '  Tempo   Deck '] then
    raise exception 'FAIL (R254): the legacy deck rows now read %, expected them untouched', v_names;
  end if;
  select count(*) into n from public.loadout_deck_cards where profile_id = legacy;
  if n <> 60 then
    raise exception 'FAIL (R254): % legacy card rows left, expected all 60', n;
  end if;

  -- Three decks, named as the loadout's decks were (the third normalised as normalizeName would),
  -- listed in slot order by the (created_at, id) order every deck list reads.
  select array_agg(name order by created_at, id), array_agg(id order by created_at, id)
    into v_names, v_ids
    from public.decks where profile_id = legacy;
  if v_names is distinct from array['Aggro', 'Control', 'Tempo Deck'] then
    raise exception 'FAIL (R254): profile 4 has decks %, expected {Aggro,Control,"Tempo Deck"} in slot order',
      v_names;
  end if;

  -- Each deck holds its slot's cards in app.resolve_deck order (card-id order), whatever order
  -- they were saved in (03b saved them in reverse), and the loadout's own catalog version.
  v_slot := 0;
  for v_deck in
    select id, name, cards, catalog_version, created_at, updated_at
      from public.decks where profile_id = legacy order by created_at, id
  loop
    v_slot := v_slot + 1;
    v_want := app.resolve_deck(legacy, v_slot);
    if v_deck.cards is distinct from v_want then
      raise exception 'FAIL (R254): deck % (slot %) holds %, expected app.resolve_deck''s %',
        v_deck.name, v_slot, v_deck.cards, v_want;
    end if;
    select jsonb_agg(format('legacy-%s', to_char(k, 'FM000')) order by k) into v_want
      from generate_series(case v_slot when 1 then 41 when 2 then 1 else 21 end,
                           case v_slot when 1 then 60 when 2 then 20 else 40 end) as k;
    if v_deck.cards is distinct from v_want then
      raise exception 'FAIL (R254): deck % (slot %) holds %, expected its 20 cards in card-id order %',
        v_deck.name, v_slot, v_deck.cards, v_want;
    end if;
    if v_deck.catalog_version <> 'core-0' then
      raise exception 'FAIL (R254): deck % carries catalog version %, expected the loadout''s core-0',
        v_deck.name, v_deck.catalog_version;
    end if;
    if v_deck.created_at <> v_loaded + v_slot * interval '1 millisecond'
       or v_deck.updated_at <> v_deck.created_at then
      raise exception 'FAIL (R254): deck % was stamped %/%, expected the loadout''s save + % ms',
        v_deck.name, v_deck.created_at, v_deck.updated_at, v_slot;
    end if;
  end loop;

  -- One trio, "My trio", holding the three in slot order.
  select count(*) into n from public.trios where profile_id = legacy;
  if n <> 1 then
    raise exception 'FAIL (R254): profile 4 has % trios, expected exactly one', n;
  end if;
  select name, deck1_id, deck2_id, deck3_id into v_trio from public.trios where profile_id = legacy;
  if v_trio.name <> 'My trio'
     or array[v_trio.deck1_id, v_trio.deck2_id, v_trio.deck3_id] is distinct from v_ids then
    raise exception 'FAIL (R254): the trio is "%" holding %, expected "My trio" holding % in slot order',
      v_trio.name, array[v_trio.deck1_id, v_trio.deck2_id, v_trio.deck3_id], v_ids;
  end if;

  -- A migration, not a trigger: profile 1 saved its loadout (03 CHECK 2) after 0007 ran, and
  -- nothing turned it into decks.
  if not exists (select 1 from public.loadouts where profile_id = p1) then
    raise exception 'FAIL (R254): profile 1 has no loadout, so "nothing converts a later one" measures nothing';
  end if;
  if exists (select 1 from public.decks where profile_id <> legacy)
     or exists (select 1 from public.trios where profile_id <> legacy) then
    raise exception 'FAIL (R254): a profile other than 4 already holds a deck or a trio before this file saved any';
  end if;

  perform set_config('r254.deck_ids', array_to_string(v_ids, ','), false);
  perform set_config('r254.trio_id',
    (select id::text from public.trios where profile_id = legacy), false);
  raise notice 'OK (R254): profile 4''s loadout became Aggro, Control and Tempo Deck (60 cards, core-0) and My trio; the loadout rows are untouched';
end $$;

\echo '-- re-applying 0007 converts nothing twice (rolled back)'
begin;
\i /tmp/0007_decks_and_trios.sql
do $$
declare
  legacy constant uuid := '44444444-4444-4444-4444-444444444444';
  p1     constant uuid := '11111111-1111-1111-1111-111111111111';
  was_decks text := current_setting('r254.deck_ids', true);
  was_trio  text := current_setting('r254.trio_id', true);
  now_decks text;
  n         bigint;
begin
  select string_agg(id::text, ',' order by created_at, id) into now_decks
    from public.decks where profile_id = legacy;
  select count(*) into n from public.trios where profile_id = legacy;
  if now_decks is distinct from was_decks or n <> 1
     or (select id::text from public.trios where profile_id = legacy) is distinct from was_trio then
    raise exception 'FAIL (R254): re-applying 0007 changed profile 4 (decks % -> %, % trios) — the conversion is not idempotent',
      was_decks, now_decks, n;
  end if;
  -- Vacuity guard: the re-run really did run the conversion — profile 1, which has a loadout and
  -- no deck, was converted by it (inside this rolled-back transaction).
  select count(*) into n from public.decks where profile_id = p1;
  if n <> 3 or not exists (select 1 from public.trios where profile_id = p1 and name = 'My trio') then
    raise exception 'FAIL (R254): the re-run converted % deck(s) for profile 1, expected 3 and My trio — it did not run at all',
      n;
  end if;
  raise notice 'OK (R254): a second run of 0007 skipped profile 4 and converted only the loadout that had no decks';
end $$;
rollback;

\echo '-- R254 on a loadout no server wrote: every name 0007 makes passes D1 (rolled back)'
begin;
-- app.save_loadout never stored names like these, but a raw write could have, and R254 promises a
-- converted deck "can be saved again as it is": a control or an invisible format character, or a
-- trailing space left by the cut, would be a name @jackioh/validator's D1 refuses.
insert into auth.users (id, email, email_confirmed_at)
values ('66666666-6666-6666-6666-666666666666', 'odd-names@example.test', now());
insert into public.loadouts (profile_id, catalog_version)
values ('66666666-6666-6666-6666-666666666666', 'core-0');
insert into public.loadout_decks (profile_id, slot, name) values
  ('66666666-6666-6666-6666-666666666666', 1, E'Bad\x01name\nhere'),
  ('66666666-6666-6666-6666-666666666666', 2, 'abcdefghijklmnopqrstuvwxyzabcdefghijklm nopqrstu'),
  ('66666666-6666-6666-6666-666666666666', 3, E'Aggro\u202Eorez\u200B');
\i /tmp/0007_decks_and_trios.sql
do $$
declare
  odd     constant uuid := '66666666-6666-6666-6666-666666666666';
  v_names text[];
begin
  select array_agg(name order by created_at, id) into v_names from public.decks where profile_id = odd;
  if v_names is distinct from array['Badname here', 'abcdefghijklmnopqrstuvwxyzabcdefghijklm', 'Aggroorez'] then
    raise exception 'FAIL (R254): odd legacy names became %, expected {"Badname here",abcdefghijklmnopqrstuvwxyzabcdefghijklm,Aggroorez}',
      v_names;
  end if;
  raise notice 'OK (R254): a raw legacy name loses its control and format characters and is trimmed after the cut';
end $$;
rollback;

\echo '### R250: app.upsert_deck saves a draft, updates it in place, caps creates and refuses a foreign id ###'
do $$
declare
  p1 constant uuid := '11111111-1111-1111-1111-111111111111';
  p2 constant uuid := '22222222-2222-2222-2222-222222222222';
  d1 constant uuid := 'a1000000-0000-4000-8000-000000000001';
  d2 constant uuid := 'a1000000-0000-4000-8000-000000000002';
  d3 constant uuid := 'a1000000-0000-4000-8000-000000000003';
  t0 constant timestamptz := '2026-01-01 00:00:00+00';
  t1 constant timestamptz := '2026-01-01 00:05:00+00';
  r   text;
  v_row record;
begin
  -- The three app.settings rows 0007 seeds mirror apps/server/src/config.ts.
  if (app.setting('max_saved_decks'))::text::int <> 10
     or (app.setting('max_saved_trios'))::text::int <> 5
     or (app.setting('deck_name_max_length'))::text::int <> 40 then
    raise exception 'FAIL (R250): app.settings holds % decks / % trios / % name characters, expected 10 / 5 / 40 as config.ts',
      app.setting('max_saved_decks'), app.setting('max_saved_trios'), app.setting('deck_name_max_length');
  end if;
  if exists (select 1 from public.decks where profile_id = p1) then
    raise exception 'FAIL (R250): profile 1 already holds decks, so the counts below are off';
  end if;

  -- A draft: three cards is not a legal deck and is saved all the same (D2 is "at most"), in the
  -- order given.
  r := app.upsert_deck(p1, d1, 'Draft', '["core-002", "bulk-003", "core-001"]', 'core-1', t0, 10);
  if r <> 'created' then
    raise exception 'FAIL (R250): a new draft answered %, expected created', r;
  end if;
  select * into v_row from public.decks where id = d1;
  if v_row.profile_id <> p1 or v_row.name <> 'Draft'
     or v_row.cards <> '["core-002", "bulk-003", "core-001"]'::jsonb
     or v_row.catalog_version <> 'core-1' or v_row.created_at <> t0 or v_row.updated_at <> t0 then
    raise exception 'FAIL (R250): the saved draft reads back as %', v_row;
  end if;

  -- R256: the same id again is the same deck, updated in place; created_at is kept.
  r := app.upsert_deck(p1, d1, 'Draft v2', '["core-001"]', 'core-1', t1, 10);
  if r <> 'updated' then
    raise exception 'FAIL (R250): saving an existing id answered %, expected updated', r;
  end if;
  select * into v_row from public.decks where id = d1;
  if v_row.name <> 'Draft v2' or v_row.cards <> '["core-001"]'::jsonb
     or v_row.created_at <> t0 or v_row.updated_at <> t1 then
    raise exception 'FAIL (R250): the update reads back as % (created_at must stay %)', v_row, t0;
  end if;
  if (select count(*) from public.decks where profile_id = p1) <> 1 then
    raise exception 'FAIL (R250): an update made a second deck';
  end if;

  -- Another profile's id: refused, and nothing about the deck changes.
  r := app.upsert_deck(p2, d1, 'Mine now', '[]', 'core-1', t1, 10);
  if r <> 'not_owner' then
    raise exception 'FAIL (R250): writing profile 1''s deck as profile 2 answered %, expected not_owner', r;
  end if;
  if (select name from public.decks where id = d1) <> 'Draft v2'
     or (select profile_id from public.decks where id = d1) <> p1 then
    raise exception 'FAIL (R250): a not_owner write changed the deck';
  end if;

  -- The cap: the caller's, and at the cap an update still lands.
  if app.upsert_deck(p1, d2, 'Second', '[]', 'core-1', t1, 2) <> 'created' then
    raise exception 'FAIL (R250): the second deck under a cap of 2 was not created';
  end if;
  r := app.upsert_deck(p1, d3, 'Third', '[]', 'core-1', t1, 2);
  if r <> 'limit' then
    raise exception 'FAIL (R250): a third deck under a cap of 2 answered %, expected limit', r;
  end if;
  if exists (select 1 from public.decks where id = d3) then
    raise exception 'FAIL (R250): a create refused at the cap still wrote a row';
  end if;
  if app.upsert_deck(p1, d2, 'Second, renamed', '[]', 'core-1', t1, 2) <> 'updated' then
    raise exception 'FAIL (R250): an update at the cap was refused';
  end if;

  -- The database's own cap, when the caller asks for more than app.settings allows.
  update app.settings set value = to_jsonb(2) where key = 'max_saved_decks';
  r := app.upsert_deck(p1, d3, 'Third', '[]', 'core-1', t1, 10);
  update app.settings set value = to_jsonb(10) where key = 'max_saved_decks';
  if r <> 'limit' then
    raise exception 'FAIL (R250): with app.settings at 2 and the caller at 10 a third deck answered %, expected limit', r;
  end if;

  raise notice 'OK (R250): created, updated in place (created_at kept, card order kept), not_owner, limit at both caps';
end $$;

\echo '-- the draft shape app.upsert_deck refuses by raising (the server refuses it first)'
do $$
declare
  p1 constant uuid := '11111111-1111-1111-1111-111111111111';
  -- [label, call, expected message prefix]
  probes constant text[][] := array[
    ['D2: 21 cards',
     $q$select app.upsert_deck('11111111-1111-1111-1111-111111111111', 'a1000000-0000-4000-8000-0000000000f1',
          'Big', (select jsonb_agg(format('bulk-%s', to_char(k, 'FM000'))) from generate_series(1, 21) k),
          'core-1', now(), 10)$q$,
     'deck: D2 21 cards'],
    ['D4: a card twice',
     $q$select app.upsert_deck('11111111-1111-1111-1111-111111111111', 'a1000000-0000-4000-8000-0000000000f2',
          'Twice', '["core-001", "core-001"]', 'core-1', now(), 10)$q$,
     'deck: D4'],
    ['D1: a blank name',
     $q$select app.upsert_deck('11111111-1111-1111-1111-111111111111', 'a1000000-0000-4000-8000-0000000000f3',
          '   ', '[]', 'core-1', now(), 10)$q$,
     'deck: a deck needs a name'],
    ['D1: 41 characters',
     $q$select app.upsert_deck('11111111-1111-1111-1111-111111111111', 'a1000000-0000-4000-8000-0000000000f4',
          repeat('x', 41), '[]', 'core-1', now(), 10)$q$,
     'deck: the name is 41 characters'],
    ['D1: a control character',
     $q$select app.upsert_deck('11111111-1111-1111-1111-111111111111', 'a1000000-0000-4000-8000-0000000000f5',
          E'Tab\there', '[]', 'core-1', now(), 10)$q$,
     'deck: the name contains a control character'],
    ['cards not an array',
     $q$select app.upsert_deck('11111111-1111-1111-1111-111111111111', 'a1000000-0000-4000-8000-0000000000f6',
          'Object', '{"core-001": 1}', 'core-1', now(), 10)$q$,
     'deck: p_cards must be a JSON array'],
    ['a card that is not a string',
     $q$select app.upsert_deck('11111111-1111-1111-1111-111111111111', 'a1000000-0000-4000-8000-0000000000f7',
          'Numbers', '[1, 2]', 'core-1', now(), 10)$q$,
     'deck: every entry of p_cards']];
  i int;
begin
  -- Vacuity guard: the same call with a legal draft succeeds, so each refusal below is about
  -- the one thing its probe changed.
  if app.upsert_deck(p1, 'a1000000-0000-4000-8000-0000000000f0', 'Control', '["core-001"]',
                     'core-1', now(), 10) <> 'created' then
    raise exception 'FAIL (R250): the control draft was not saved, so the refusals below prove nothing';
  end if;
  delete from public.decks where id = 'a1000000-0000-4000-8000-0000000000f0';

  for i in 1 .. array_length(probes, 1) loop
    begin
      execute probes[i][2];
      raise exception 'FAIL (R250): % was saved — app.upsert_deck must refuse it', probes[i][1];
    exception when others then
      if sqlerrm like 'FAIL%' then raise; end if;
      if sqlerrm not like probes[i][3] || '%' then
        raise exception 'FAIL (R250): % raised "%" (%), expected a message starting "%"',
          probes[i][1], sqlerrm, sqlstate, probes[i][3];
      end if;
    end;
  end loop;
  if exists (select 1 from public.decks where id::text like 'a1000000-0000-4000-8000-0000000000f%') then
    raise exception 'FAIL (R250): a refused draft left a row behind';
  end if;
  raise notice 'OK (R250): D1 (blank, too long, control character), D2, D4 and a malformed cards value all refused';
end $$;

\echo '-- a profile that is not active saves no deck (rolled back)'
begin;
insert into auth.users (id, email, email_confirmed_at)
values ('55555555-5555-5555-5555-555555555555', 'pending@example.test', now());
do $$
begin
  if (select status from public.profiles where id = '55555555-5555-5555-5555-555555555555') <> 'pending' then
    raise exception 'FAIL (R250): profile 5 is not pending, so the gate below is not exercised';
  end if;
  perform app.upsert_deck('55555555-5555-5555-5555-555555555555', 'a1000000-0000-4000-8000-0000000000e1',
                          'Early', '[]', 'core-1', now(), 10);
  raise exception 'FAIL (R250): a pending profile saved a deck — §9.4 gives it nothing but the code screen';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  if sqlerrm not like 'deck: profile % is not active (status=pending)' then
    raise exception 'FAIL (R250): the pending profile was refused with "%" (%), not the active-profile gate',
      sqlerrm, sqlstate;
  end if;
  raise notice 'OK (R250): %', sqlerrm;
end $$;
rollback;

\echo '### R252: a trio names the profile own distinct decks, and deleting a deck empties its slots ###'
do $$
declare
  p1 constant uuid := '11111111-1111-1111-1111-111111111111';
  p2 constant uuid := '22222222-2222-2222-2222-222222222222';
  x  constant uuid := 'b1000000-0000-4000-8000-000000000001';
  y  constant uuid := 'b1000000-0000-4000-8000-000000000002';
  z  constant uuid := 'b1000000-0000-4000-8000-000000000003';
  w  constant uuid := 'b2000000-0000-4000-8000-000000000001';
  t1 constant uuid := 'c1000000-0000-4000-8000-000000000001';
  t2 constant uuid := 'c1000000-0000-4000-8000-000000000002';
  t3 constant uuid := 'c1000000-0000-4000-8000-000000000003';
  r   text;
  v_row record;
  refused_by text;
begin
  if app.upsert_deck(p1, x, 'X', '[]', 'core-1', now(), 10) <> 'created'
     or app.upsert_deck(p1, y, 'Y', '[]', 'core-1', now(), 10) <> 'created'
     or app.upsert_deck(p1, z, 'Z', '[]', 'core-1', now(), 10) <> 'created'
     or app.upsert_deck(p2, w, 'W', '[]', 'core-1', now(), 10) <> 'created' then
    raise exception 'FAIL (R252): the four decks this check builds trios from were not all created';
  end if;

  -- Three ordered slots, one of them empty.
  r := app.upsert_trio(p1, t1, 'Ladder', x, null, y, now(), 5);
  if r <> 'created' then
    raise exception 'FAIL (R252): a trio of x, empty, y answered %, expected created', r;
  end if;
  select * into v_row from public.trios where id = t1;
  if v_row.deck1_id is distinct from x or v_row.deck2_id is not null or v_row.deck3_id is distinct from y then
    raise exception 'FAIL (R252): the trio reads back as %', v_row;
  end if;
  if app.upsert_trio(p1, t1, 'Ladder', x, z, y, now(), 5) <> 'updated' then
    raise exception 'FAIL (R252): filling the empty slot was not an update';
  end if;

  -- Another profile's trio id; another profile's deck; a deck that does not exist.
  if app.upsert_trio(p2, t1, 'Mine', null, null, null, now(), 5) <> 'not_owner' then
    raise exception 'FAIL (R252): profile 2 writing profile 1''s trio was not not_owner';
  end if;
  r := app.upsert_trio(p1, t2, 'Borrowed', w, null, null, now(), 5);
  if r <> 'unknown_deck' then
    raise exception 'FAIL (R252): a slot naming profile 2''s deck answered %, expected unknown_deck', r;
  end if;
  r := app.upsert_trio(p1, t2, 'Ghost', 'b9999999-0000-4000-8000-000000000000', null, null, now(), 5);
  if r <> 'unknown_deck' then
    raise exception 'FAIL (R252): a slot naming no deck at all answered %, expected unknown_deck', r;
  end if;
  if exists (select 1 from public.trios where id = t2) then
    raise exception 'FAIL (R252): an unknown_deck answer still wrote a trio';
  end if;

  -- The cap: profile 1 holds one trio, and a cap of 1 refuses a second.
  if app.upsert_trio(p1, t2, 'Second', null, null, null, now(), 1) <> 'limit' then
    raise exception 'FAIL (R252): a second trio under a cap of 1 was not refused with limit';
  end if;

  -- T3, by constraint: one deck in two slots.
  begin
    perform app.upsert_trio(p1, t3, 'Twice', z, z, null, now(), 5);
    raise exception 'FAIL (R252): a trio holding one deck twice was saved';
  exception
    when check_violation then
      get stacked diagnostics refused_by = constraint_name;
      if refused_by is distinct from 'trios_decks_distinct' then
        raise exception 'FAIL (R252): the doubled deck was refused by "%", not trios_decks_distinct', refused_by;
      end if;
    when others then
      if sqlerrm like 'FAIL%' then raise; end if;
      raise exception 'FAIL (R252): the doubled deck raised "%" (%), not a check violation', sqlerrm, sqlstate;
  end;

  -- The composite foreign key holds without the function: a raw row naming profile 2's deck.
  begin
    insert into public.trios (id, profile_id, name, deck1_id) values (t3, p1, 'Stolen', w);
    raise exception 'FAIL (R252): a raw trio row holds another profile''s deck';
  exception
    when foreign_key_violation then
      get stacked diagnostics refused_by = constraint_name;
      if refused_by is distinct from 'trios_deck1_fk' then
        raise exception 'FAIL (R252): the borrowed deck was refused by "%", not trios_deck1_fk', refused_by;
      end if;
    when others then
      if sqlerrm like 'FAIL%' then raise; end if;
      raise exception 'FAIL (R252): the borrowed deck raised "%" (%), not a foreign-key violation', sqlerrm, sqlstate;
  end;

  -- "Deleting a deck empties every slot that named it and keeps the trio": a plain delete, as
  -- the server makes it, and the foreign keys do the rest in the same statement.
  delete from public.decks where id = x;
  select * into v_row from public.trios where id = t1;
  if not found then
    raise exception 'FAIL (R252): deleting a deck deleted the trio that held it';
  end if;
  if v_row.deck1_id is not null or v_row.deck2_id is distinct from z or v_row.deck3_id is distinct from y
     or v_row.profile_id <> p1 then
    raise exception 'FAIL (R252): after deleting x the trio reads %, expected (empty, z, y) and still profile 1''s', v_row;
  end if;
  delete from public.decks where id = y;
  if (select deck3_id from public.trios where id = t1) is not null then
    raise exception 'FAIL (R252): deleting y did not empty slot 3';
  end if;

  raise notice 'OK (R252): created with an empty slot, updated, not_owner, unknown_deck (foreign and missing), limit, T3 and the foreign key refused, and deleting a deck emptied its slots';
end $$;

\echo '### R257: a ticket carries its mode, and exactly a Best-of-3 ticket carries a trio ###'
begin;
do $$
declare
  p1 constant uuid := '11111111-1111-1111-1111-111111111111';
  trio3 constant jsonb := '{"name": "Ladder", "decks": [{"name": "A", "cards": []}, {"name": "B", "cards": []}, {"name": "C", "cards": []}]}';
  trio2 constant jsonb := '{"name": "Short", "decks": [{"name": "A", "cards": []}, {"name": "B", "cards": []}]}';
  v_mode text;
  v_slot int;
  refused_by text;
  -- [label, frozen trio, mode, the constraint that must refuse it]
  i int;
  labels  constant text[] := array['bo3 with no trio', 'bo1 with a trio', 'random with a trio',
                                   'a trio of two decks', 'mode bo5'];
  modes   constant text[] := array['bo3', 'bo1', 'random', 'bo3', 'bo5'];
  trios   constant jsonb[] := array[null, trio3, trio3, trio2, null];
  wanted  constant text[] := array['tickets_frozen_trio_check', 'tickets_frozen_trio_check',
                                   'tickets_frozen_trio_check', 'tickets_frozen_trio_shape_check',
                                   'tickets_mode_check'];
begin
  -- A ticket written as 0004 wrote one is Best of 1, with no slot any more (0008).
  insert into public.tickets (id, profile_id, rating, frozen_deck, catalog_version, status)
  values ('a7000000-0000-4000-8000-000000000001', p1, 1000, '["core-001"]', 'core-1', 'cancelled')
  returning mode, slot into v_mode, v_slot;
  if v_mode <> 'bo1' or v_slot is not null then
    raise exception 'FAIL (R257): a ticket with no mode reads mode % slot %, expected bo1 and no slot', v_mode, v_slot;
  end if;

  -- Controls: each legal combination lands.
  insert into public.tickets (id, profile_id, rating, mode, frozen_deck, frozen_trio, catalog_version, status)
  values ('a7000000-0000-4000-8000-000000000002', p1, 1000, 'bo3', '[]', trio3, 'core-1', 'cancelled'),
         ('a7000000-0000-4000-8000-000000000003', p1, 1000, 'random', '[]', null, 'core-1', 'cancelled');

  for i in 1 .. array_length(labels, 1) loop
    begin
      insert into public.tickets (id, profile_id, rating, mode, frozen_deck, frozen_trio, catalog_version, status)
      values (gen_random_uuid(), p1, 1000, modes[i], '[]', trios[i], 'core-1', 'cancelled');
      raise exception 'FAIL (R257): a ticket with % was stored', labels[i];
    exception
      when check_violation then
        get stacked diagnostics refused_by = constraint_name;
        if refused_by is distinct from wanted[i] then
          raise exception 'FAIL (R257): % was refused by "%", expected %', labels[i], refused_by, wanted[i];
        end if;
      when others then
        if sqlerrm like 'FAIL%' then raise; end if;
        raise exception 'FAIL (R257): % raised "%" (%), not a check violation', labels[i], sqlerrm, sqlstate;
    end;
  end loop;

  -- "The queue population is reported per mode": the partial index over queued tickets by mode.
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'tickets_queued_mode_idx'
       and indexdef like '%(mode, enqueued_at)%' and indexdef like '%WHERE (status = ''queued''::text)%'
  ) then
    raise exception 'FAIL (R257): tickets_queued_mode_idx is missing or no longer (mode, enqueued_at) over queued tickets';
  end if;

  raise notice 'OK (R257): bo1 by default with no slot; bo3 needs a three-deck trio and nothing else may carry one; an unknown mode is refused';
end $$;
rollback;

\echo '### R264: a room keeps its mode, and exactly a Best-of-3 room keeps a trio ###'
begin;
do $$
declare
  p1 constant uuid := '11111111-1111-1111-1111-111111111111';
  trio3 constant jsonb := '{"name": "Ladder", "decks": [{"name": "A", "cards": []}, {"name": "B", "cards": []}, {"name": "C", "cards": []}]}';
  refused_by text;
  i int;
  labels  constant text[] := array['bo3 with no trio', 'no mode with a trio', 'bo1 with a trio', 'mode bo5'];
  codes   constant text[] := array['QRS237', 'QRS238', 'QRS239', 'QRS242'];
  modes   constant text[] := array['bo3', null, 'bo1', 'bo5'];
  trios   constant jsonb[] := array[null, trio3, trio3, null];
  wanted  constant text[] := array['matches_room_trio_check', 'matches_room_trio_check',
                                   'matches_room_trio_check', 'matches_room_mode_check'];
begin
  -- Controls: a Best-of-3 room with its trio, an All Random room, and a room as 0004's
  -- app.create_room still writes one (no mode, which the server reads as bo1).
  insert into public.matches (room_code, room_mode, room_trio, status, seed, p1_profile_id, p1_deck,
                              catalog_version, ceiling_at)
  values ('QRS234', 'bo3', trio3, 'open', '', p1, '[]', 'core-1', 'infinity'),
         ('QRS235', 'random', null, 'open', '', p1, '[]', 'core-1', 'infinity');
  perform app.create_room(p1, 'QRS236', 'seed', '["core-001"]', 'core-1');
  if (select room_mode from public.matches where room_code = 'QRS236') is not null then
    raise exception 'FAIL (R264): app.create_room''s room has a mode; it predates modes';
  end if;

  for i in 1 .. array_length(labels, 1) loop
    begin
      insert into public.matches (room_code, room_mode, room_trio, status, seed, p1_profile_id, p1_deck,
                                  catalog_version, ceiling_at)
      values (codes[i], modes[i], trios[i], 'open', '', p1, '[]', 'core-1', 'infinity');
      raise exception 'FAIL (R264): a room with % was stored', labels[i];
    exception
      when check_violation then
        get stacked diagnostics refused_by = constraint_name;
        if refused_by is distinct from wanted[i] then
          raise exception 'FAIL (R264): % was refused by "%", expected %', labels[i], refused_by, wanted[i];
        end if;
      when others then
        if sqlerrm like 'FAIL%' then raise; end if;
        raise exception 'FAIL (R264): % raised "%" (%), not a check violation', labels[i], sqlerrm, sqlstate;
    end;
  end loop;
  raise notice 'OK (R264): a room keeps its mode; a trio exactly on a Best-of-3 room; an unknown mode refused';
end $$;
rollback;

\echo '### R263: a series is a server-only row, written by compare-and-set, found by its next match and by any game ###'
do $$
declare
  n    bigint;
  def  text;
  opc  text;
begin
  -- TRUST BOUNDARY (0009): RLS on, no policy, no client privilege of any kind. 02 CHECK 3 shows
  -- the refusal from a client session; this is the catalog saying there is nothing to refuse
  -- with, so a policy added later would fail here too.
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.series'::regclass) then
    raise exception 'FAIL (R263): public.series does not have row level security enabled';
  end if;
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'series';
  if n <> 0 then
    raise exception 'FAIL (R263): public.series has % polic(ies); picks and trios are hidden (R259), it must have none', n;
  end if;
  select count(*) into n
    from pg_class c
    cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
    left join pg_roles g on g.oid = a.grantee
   where c.oid = 'public.series'::regclass
     and coalesce(g.rolname, 'PUBLIC') in ('anon', 'authenticated', 'PUBLIC');
  if n <> 0 then
    raise exception 'FAIL (R263): a client role holds % privilege(s) on public.series', n;
  end if;

  -- "The next game's match id is reserved when its pick phase opens": before the match exists,
  -- so no foreign key may hold it.
  if exists (
    select 1 from pg_constraint k
      join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any (k.conkey)
     where k.conrelid = 'public.series'::regclass and k.contype = 'f' and a.attname = 'next_match_id'
  ) then
    raise exception 'FAIL (R263): series.next_match_id has a foreign key — a reserved id names no match yet';
  end if;

  -- The lookups: one series per next match (unique), and any game through a GIN index.
  if not exists (
    select 1 from pg_index i
     where i.indexrelid = to_regclass('public.series_next_match_id_key') and i.indisunique
  ) then
    raise exception 'FAIL (R263): series_next_match_id_key is missing or not unique';
  end if;
  select pg_get_indexdef(i.indexrelid), o.opcname into def, opc
    from pg_index i join pg_opclass o on o.oid = i.indclass[0]
   where i.indexrelid = to_regclass('public.series_games_idx');
  if def is null or def not like '%USING gin%' or def not like '%(state -> ''games''::text)%'
     or opc <> 'jsonb_path_ops' then
    raise exception 'FAIL (R263): series_games_idx is % (opclass %), expected GIN jsonb_path_ops over state -> games',
      def, opc;
  end if;
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'series_active_idx'
       and indexdef like '%WHERE (status <> ''over''::text)%'
  ) then
    raise exception 'FAIL (R263): series_active_idx is missing or no longer covers only the series not over';
  end if;
  raise notice 'OK (R263): series is RLS-on with no policy and no client grant; next_match_id has no FK; the lookups are indexed';
end $$;

begin;
do $$
declare
  p1 constant uuid := '11111111-1111-1111-1111-111111111111';
  p2 constant uuid := '22222222-2222-2222-2222-222222222222';
  s1 constant uuid := 'f1000000-0000-4000-8000-000000000001';
  m1 constant uuid := 'f1000000-0000-4000-8000-0000000000a1';
  m2 constant uuid := 'f1000000-0000-4000-8000-0000000000a2';
  state0 constant jsonb := '{"sides": [], "games": [], "seedBase": "s"}';
  moved  int;
  found_id uuid;
  refused_by text;
begin
  -- A series reserving a match id that no match row has.
  if exists (select 1 from public.matches where id = m1) then
    raise exception 'FAIL (R263): match % exists, so the reservation below proves nothing', m1;
  end if;
  insert into public.series (id, p1_profile_id, p2_profile_id, status, next_match_id, version,
                             catalog_version, state)
  values (s1, p1, p2, 'picking', m1, 1, 'core-1', state0);

  -- Compare-and-set: the write over version 1 lands once; a second writer that also read
  -- version 1 moves nothing.
  update public.series set status = 'playing', version = 2,
         state = jsonb_set(state, '{games}', jsonb_build_array(jsonb_build_object('gameNo', 1, 'matchId', m1)))
   where id = s1 and version = 2 - 1;
  get diagnostics moved = row_count;
  if moved <> 1 then
    raise exception 'FAIL (R263): the first compare-and-set moved % row(s), expected 1', moved;
  end if;
  update public.series set status = 'over', version = 2 where id = s1 and version = 2 - 1;
  get diagnostics moved = row_count;
  if moved <> 0 or (select status from public.series where id = s1) <> 'playing' then
    raise exception 'FAIL (R263): a stale compare-and-set moved % row(s) — the losing writer overwrote the winner', moved;
  end if;

  -- Found by the match in play, and by a game it holds.
  select id into found_id from public.series where next_match_id = m1 and status = 'playing';
  if found_id is distinct from s1 then
    raise exception 'FAIL (R263): the series playing % was not found by next_match_id', m1;
  end if;
  select id into found_id from public.series
   where state -> 'games' @> jsonb_build_array(jsonb_build_object('matchId', m1));
  if found_id is distinct from s1 then
    raise exception 'FAIL (R263): the series whose game was % was not found by containment', m1;
  end if;
  if exists (select 1 from public.series
              where state -> 'games' @> jsonb_build_array(jsonb_build_object('matchId', m2))) then
    raise exception 'FAIL (R263): containment found a series for a match none of them played';
  end if;

  -- One series per reserved id.
  begin
    insert into public.series (id, p1_profile_id, p2_profile_id, status, next_match_id, version,
                               catalog_version, state)
    values (gen_random_uuid(), p2, p1, 'picking', m1, 1, 'core-1', state0);
    raise exception 'FAIL (R263): two series reserved the same match id';
  exception
    when unique_violation then
      get stacked diagnostics refused_by = constraint_name;
      if refused_by is distinct from 'series_next_match_id_key' then
        raise exception 'FAIL (R263): the shared reservation was refused by "%", not series_next_match_id_key', refused_by;
      end if;
    when others then
      if sqlerrm like 'FAIL%' then raise; end if;
      raise exception 'FAIL (R263): the shared reservation raised "%" (%)', sqlerrm, sqlstate;
  end;

  -- The column checks: a status, a winner and two different players.
  begin
    update public.series set status = 'paused' where id = s1;
    raise exception 'FAIL (R263): a series took the status paused';
  exception
    when check_violation then
      get stacked diagnostics refused_by = constraint_name;
      if refused_by is distinct from 'series_status_check' then
        raise exception 'FAIL (R263): status paused was refused by "%"', refused_by;
      end if;
  end;
  begin
    update public.series set winner = 'p3' where id = s1;
    raise exception 'FAIL (R263): a series took the winner p3';
  exception
    when check_violation then
      get stacked diagnostics refused_by = constraint_name;
      if refused_by is distinct from 'series_winner_check' then
        raise exception 'FAIL (R263): winner p3 was refused by "%"', refused_by;
      end if;
  end;
  begin
    update public.series set p2_profile_id = p1 where id = s1;
    raise exception 'FAIL (R263): a series paired a profile with itself';
  exception
    when check_violation then
      get stacked diagnostics refused_by = constraint_name;
      if refused_by is distinct from 'series_players_differ_check' then
        raise exception 'FAIL (R263): the self-pairing was refused by "%"', refused_by;
      end if;
  end;

  raise notice 'OK (R263): a series reserves a match id with no match, compare-and-set lands once, and it is found by next match and by game';
end $$;
rollback;

\echo '### ALL DECK, MODE AND SERIES CHECKS RAN ###'
