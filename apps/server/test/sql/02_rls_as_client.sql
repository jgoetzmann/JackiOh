\set ON_ERROR_STOP on

-- The critical test: act as the `authenticated` role inside a transaction, so
-- SET LOCAL actually takes effect and RLS is really exercised.
-- Profile 1 is active with a collection; profile 2 exists and is pending.
--
-- Every check below must FAIL LOUDLY when the invariant in its heading is violated,
-- the same way 01_schema_invariants.sql does it. A `select` that prints rows is a
-- diagnostic, never the check: psql prints the number and moves on whether the answer
-- was right or wrong. So each heading keeps its `select` for the human reading the log,
-- and follows it with a `do $$ ... raise exception 'FAIL (CHECK n): ...' $$` block that
-- is the actual assertion. `raise exception` plus `\set ON_ERROR_STOP on` makes psql
-- exit non-zero, which run.sh turns into a non-zero exit for the whole suite;
-- `raise notice 'FAIL ...'` does NOT stop psql, so inside this file the FAIL path is
-- always `raise exception`.
--
-- Two guards every check in this file needs, because this file is about *hidden* data:
--
--   * `current_user = 'authenticated'`. Issued outside a transaction block, `set local
--     role` is ignored with a warning and the session stays superuser — which BYPASSES
--     RLS, so every count comes back as the whole table while a counting check still
--     passes. That is exactly how 01's CHECK 12 used to pass vacuously.
--
--   * something to hide. "No rows visible" is trivially true when there are no rows at
--     all. Profile 2 owns nothing when this file starts (01's CHECK 12 rolled its seed
--     back), so CHECK 1 seeds one row of everything *for profile 2* inside its own
--     transaction and rolls it back, and CHECK 2 measures against profile 1's real
--     rows. Both assert those foreign rows exist before concluding anything from a
--     count. The totals are read as superuser before the role switch and handed to the
--     assertion block through transaction-local GUCs.

\echo '### as authenticated = profile 1 ###'
begin;

-- Something to hide (see the header): profile 2 owns nothing at this point, so
-- "collection: must be 2 (own rows only)" would be right for the wrong reason — there
-- is no other profile's row for RLS to withhold. These five rows give profile 2 one of
-- everything profile 1 has. The `rollback` at the end of the check removes them again,
-- so 03_match_lifecycle.sql sees the database exactly as 01 left it.
insert into public.collection (profile_id, card_id, quantity)
values ('22222222-2222-2222-2222-222222222222', 'core-002', 1);
insert into public.collection_grants (profile_id, card_id, delta, reason)
values ('22222222-2222-2222-2222-222222222222', 'core-002', 1, 'admin');
insert into public.loadouts (profile_id, catalog_version)
values ('22222222-2222-2222-2222-222222222222', 'core-1');
insert into public.loadout_decks (profile_id, slot, name)
values ('22222222-2222-2222-2222-222222222222', 1, 'P2 One');
insert into public.loadout_deck_cards (profile_id, slot, card_id, count)
values ('22222222-2222-2222-2222-222222222222', 1, 'core-002', 1);
-- 0007's decks and trios (R250, R252), one of each for BOTH profiles: profile 2's are the rows
-- to hide, profile 1's the rows it must still see (it has saved none by this point). Raw
-- inserts, as superuser, because the point is what RLS shows, not how a row got there.
insert into public.decks (id, profile_id, name, cards, catalog_version) values
  ('d1000000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', 'P1 Deck',
   '["core-001"]', 'core-1'),
  ('d2000000-0000-4000-8000-000000000002', '22222222-2222-2222-2222-222222222222', 'P2 Deck',
   '["core-002"]', 'core-1');
insert into public.trios (id, profile_id, name, deck1_id) values
  ('e1000000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', 'P1 Trio',
   'd1000000-0000-4000-8000-000000000001'),
  ('e2000000-0000-4000-8000-000000000002', '22222222-2222-2222-2222-222222222222', 'P2 Trio',
   'd2000000-0000-4000-8000-000000000002');

-- Read as superuser, with RLS bypassed: the totals the client's answers are measured
-- against. Transaction-local, like the seed rows themselves.
do $$
declare
  caller constant uuid := '11111111-1111-1111-1111-111111111111';
begin
  perform set_config('rls1.profiles_total',
    (select count(*) from public.profiles)::text, true);
  perform set_config('rls1.cards_total',
    (select count(*) from public.cards)::text, true);
  perform set_config('rls1.collection_own',
    (select count(*) from public.collection where profile_id = caller)::text, true);
  perform set_config('rls1.collection_other',
    (select count(*) from public.collection where profile_id <> caller)::text, true);
  perform set_config('rls1.grants_own',
    (select count(*) from public.collection_grants where profile_id = caller)::text, true);
  perform set_config('rls1.grants_other',
    (select count(*) from public.collection_grants where profile_id <> caller)::text, true);
  perform set_config('rls1.loadouts_own',
    (select count(*) from public.loadouts where profile_id = caller)::text, true);
  perform set_config('rls1.loadouts_other',
    (select count(*) from public.loadouts where profile_id <> caller)::text, true);
  perform set_config('rls1.deck_cards_own',
    (select count(*) from public.loadout_deck_cards where profile_id = caller)::text, true);
  perform set_config('rls1.deck_cards_other',
    (select count(*) from public.loadout_deck_cards where profile_id <> caller)::text, true);
  perform set_config('rls1.decks_own',
    (select count(*) from public.decks where profile_id = caller)::text, true);
  perform set_config('rls1.decks_other',
    (select count(*) from public.decks where profile_id <> caller)::text, true);
  perform set_config('rls1.trios_own',
    (select count(*) from public.trios where profile_id = caller)::text, true);
  perform set_config('rls1.trios_other',
    (select count(*) from public.trios where profile_id <> caller)::text, true);
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);

\echo '-- profiles: must be 1 (own row only)'
select count(*) as profiles_visible from public.profiles;
\echo '-- collection: must be 2 (own rows only)'
select count(*) as collection_visible from public.collection;
\echo '-- collection_grants: must be 2 (own rows only)'
select count(*) as grants_visible from public.collection_grants;
\echo '-- cards: must be 3 (the catalog is public to a logged-in user)'
select count(*) as cards_visible from public.cards;
\echo '-- loadouts: must be 1 (own row only)'
select count(*) as loadouts_visible from public.loadouts;
\echo '-- loadout_deck_cards: must be 1 (own rows only)'
select count(*) as deck_cards_visible from public.loadout_deck_cards;
\echo '-- decks, trios: must be 1 each (own rows only)'
select count(*) as decks_visible from public.decks;
select count(*) as trios_visible from public.trios;

do $$
declare
  caller constant uuid := '11111111-1111-1111-1111-111111111111';
  -- Read with `missing_ok`, defaulting to -1, so a check that ever loses its
  -- transaction reports *that* rather than dying in a cast (01 CHECK 12's idiom).
  profiles_total   bigint := coalesce(nullif(current_setting('rls1.profiles_total',   true), ''), '-1')::bigint;
  cards_total      bigint := coalesce(nullif(current_setting('rls1.cards_total',      true), ''), '-1')::bigint;
  collection_own   bigint := coalesce(nullif(current_setting('rls1.collection_own',   true), ''), '-1')::bigint;
  collection_other bigint := coalesce(nullif(current_setting('rls1.collection_other', true), ''), '-1')::bigint;
  grants_own       bigint := coalesce(nullif(current_setting('rls1.grants_own',       true), ''), '-1')::bigint;
  grants_other     bigint := coalesce(nullif(current_setting('rls1.grants_other',     true), ''), '-1')::bigint;
  loadouts_own     bigint := coalesce(nullif(current_setting('rls1.loadouts_own',     true), ''), '-1')::bigint;
  loadouts_other   bigint := coalesce(nullif(current_setting('rls1.loadouts_other',   true), ''), '-1')::bigint;
  deck_cards_own   bigint := coalesce(nullif(current_setting('rls1.deck_cards_own',   true), ''), '-1')::bigint;
  deck_cards_other bigint := coalesce(nullif(current_setting('rls1.deck_cards_other', true), ''), '-1')::bigint;
  decks_own        bigint := coalesce(nullif(current_setting('rls1.decks_own',        true), ''), '-1')::bigint;
  decks_other      bigint := coalesce(nullif(current_setting('rls1.decks_other',      true), ''), '-1')::bigint;
  trios_own        bigint := coalesce(nullif(current_setting('rls1.trios_own',        true), ''), '-1')::bigint;
  trios_other      bigint := coalesce(nullif(current_setting('rls1.trios_other',      true), ''), '-1')::bigint;
  seen             bigint;
begin
  -- Without this the whole check is theatre: a superuser reads every row and passes.
  if current_user <> 'authenticated' then
    raise exception 'FAIL (CHECK 1): running as %, not authenticated — SET LOCAL did not take',
      current_user;
  end if;
  if decks_own < 1 or trios_own < 1 or decks_other < 1 or trios_other < 1 then
    raise exception
      'FAIL (CHECK 1): decks/trios have nothing to measure — own % / %, foreign % / % (each must be at least 1)',
      decks_own, trios_own, decks_other, trios_other;
  end if;

  -- Vacuity guards. Every count below is of the form "exactly my own rows"; each one is
  -- trivially true if the other profile has no row of that kind for RLS to withhold, and
  -- equally trivial if this profile has none of its own to see.
  if profiles_total < 2 then
    raise exception
      'FAIL (CHECK 1): % profile row(s) exist — with fewer than two there is no other profile to hide',
      profiles_total;
  end if;
  if cards_total < 1 then
    raise exception
      'FAIL (CHECK 1): the catalog is empty, so "the catalog is readable" measured nothing';
  end if;
  if collection_other < 1 or grants_other < 1 or loadouts_other < 1 or deck_cards_other < 1 then
    raise exception
      'FAIL (CHECK 1): nothing to hide — foreign rows: % collection, % collection_grants, % loadouts, % loadout_deck_cards (each must be at least 1)',
      collection_other, grants_other, loadouts_other, deck_cards_other;
  end if;
  if collection_own < 1 or grants_own < 1 or loadouts_own < 1 or deck_cards_own < 1 then
    raise exception
      'FAIL (CHECK 1): profile 1 owns nothing to read — own rows: % collection, % collection_grants, % loadouts, % loadout_deck_cards',
      collection_own, grants_own, loadouts_own, deck_cards_own;
  end if;

  -- SPEC §9.1: a profile reads a projection of its own rows and of nobody else's. Both
  -- halves are asserted per table: the count it sees, and the absence of any foreign row
  -- in what it sees (a count alone cannot tell "my 2 rows" from "some other 2 rows").
  select count(*) into seen from public.profiles;
  if seen <> 1 or exists (select 1 from public.profiles where id <> caller) then
    raise exception 'FAIL (CHECK 1): profiles showed % of % rows, expected only profile 1s own row',
      seen, profiles_total;
  end if;

  select count(*) into seen from public.collection;
  if seen <> collection_own or exists (select 1 from public.collection where profile_id <> caller) then
    raise exception
      'FAIL (CHECK 1): collection showed % rows, expected % own — % rows belong to another profile and must stay hidden',
      seen, collection_own, collection_other;
  end if;

  select count(*) into seen from public.collection_grants;
  if seen <> grants_own or exists (select 1 from public.collection_grants where profile_id <> caller) then
    raise exception
      'FAIL (CHECK 1): collection_grants showed % rows, expected % own — % belong to another profile',
      seen, grants_own, grants_other;
  end if;

  select count(*) into seen from public.loadouts;
  if seen <> loadouts_own or exists (select 1 from public.loadouts where profile_id <> caller) then
    raise exception
      'FAIL (CHECK 1): loadouts showed % rows, expected % own — % belong to another profile',
      seen, loadouts_own, loadouts_other;
  end if;

  select count(*) into seen from public.loadout_deck_cards;
  if seen <> deck_cards_own or exists (select 1 from public.loadout_deck_cards where profile_id <> caller) then
    raise exception
      'FAIL (CHECK 1): loadout_deck_cards showed % rows, expected % own — % belong to another profile; a decklist is exactly what SPEC §9.8 says never leaves the server',
      seen, deck_cards_own, deck_cards_other;
  end if;

  -- R250, R252 (0007): a player's saved decks and trios are its own, exactly as its loadout
  -- was. A saved decklist is SPEC §9.8's hidden information like any other.
  select count(*) into seen from public.decks;
  if seen <> decks_own or exists (select 1 from public.decks where profile_id <> caller) then
    raise exception
      'FAIL (CHECK 1): decks showed % rows, expected % own — % belong to another profile; a saved decklist leaked',
      seen, decks_own, decks_other;
  end if;

  select count(*) into seen from public.trios;
  if seen <> trios_own or exists (select 1 from public.trios where profile_id <> caller) then
    raise exception 'FAIL (CHECK 1): trios showed % rows, expected % own — % belong to another profile',
      seen, trios_own, trios_other;
  end if;

  -- SPEC §9.4: the catalog is public to a logged-in user, so hiding it is a failure too.
  select count(*) into seen from public.cards;
  if seen <> cards_total then
    raise exception 'FAIL (CHECK 1): cards showed % of % rows; the whole catalog is readable',
      seen, cards_total;
  end if;

  raise notice 'OK (CHECK 1): profile 1 sees 1 profile, % collection, % grants, % loadouts, % deck cards, % decks, % trios, % cards — and % foreign rows stayed hidden',
    collection_own, grants_own, loadouts_own, deck_cards_own, decks_own, trios_own, cards_total,
    collection_other + grants_other + loadouts_other + deck_cards_other + decks_other + trios_other
      + (profiles_total - 1);
end $$;

reset role;
rollback;

\echo '### as authenticated = profile 2 (owns nothing) ###'
begin;

-- Profile 2 really does own nothing here, so every "must be 0" below is measured
-- against profile 1's real rows: those are what RLS has to withhold, and the assertion
-- block refuses to conclude anything unless they exist. Profile 1 has saved no deck or
-- trio by this point, so one of each is written for it here and rolled back at the end.
insert into public.decks (id, profile_id, name, cards, catalog_version) values
  ('d1000000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', 'P1 Deck',
   '["core-001"]', 'core-1');
insert into public.trios (id, profile_id, name, deck1_id) values
  ('e1000000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', 'P1 Trio',
   'd1000000-0000-4000-8000-000000000001');

do $$
declare
  caller constant uuid := '22222222-2222-2222-2222-222222222222';
begin
  perform set_config('rls2.profiles_total',
    (select count(*) from public.profiles)::text, true);
  perform set_config('rls2.collection_other',
    (select count(*) from public.collection where profile_id <> caller)::text, true);
  perform set_config('rls2.grants_other',
    (select count(*) from public.collection_grants where profile_id <> caller)::text, true);
  perform set_config('rls2.loadouts_other',
    (select count(*) from public.loadouts where profile_id <> caller)::text, true);
  perform set_config('rls2.deck_cards_other',
    (select count(*) from public.loadout_deck_cards where profile_id <> caller)::text, true);
  perform set_config('rls2.decks_other',
    (select count(*) from public.decks where profile_id <> caller)::text, true);
  perform set_config('rls2.trios_other',
    (select count(*) from public.trios where profile_id <> caller)::text, true);
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);

\echo '-- profiles: must be 1 (its own row, not profile 1s)'
select count(*) as profiles_visible from public.profiles;
\echo '-- collection: must be 0 (profile 1s rows must NOT be visible)'
select count(*) as collection_visible from public.collection;
\echo '-- collection_grants: must be 0'
select count(*) as grants_visible from public.collection_grants;
\echo '-- loadouts: must be 0'
select count(*) as loadouts_visible from public.loadouts;
\echo '-- loadout_deck_cards: must be 0'
select count(*) as deck_cards_visible from public.loadout_deck_cards;
\echo '-- decks, trios: must be 0'
select count(*) as decks_visible from public.decks;
select count(*) as trios_visible from public.trios;

do $$
declare
  caller constant uuid := '22222222-2222-2222-2222-222222222222';
  profiles_total   bigint := coalesce(nullif(current_setting('rls2.profiles_total',   true), ''), '-1')::bigint;
  collection_other bigint := coalesce(nullif(current_setting('rls2.collection_other', true), ''), '-1')::bigint;
  grants_other     bigint := coalesce(nullif(current_setting('rls2.grants_other',     true), ''), '-1')::bigint;
  loadouts_other   bigint := coalesce(nullif(current_setting('rls2.loadouts_other',   true), ''), '-1')::bigint;
  deck_cards_other bigint := coalesce(nullif(current_setting('rls2.deck_cards_other', true), ''), '-1')::bigint;
  decks_other      bigint := coalesce(nullif(current_setting('rls2.decks_other',      true), ''), '-1')::bigint;
  trios_other      bigint := coalesce(nullif(current_setting('rls2.trios_other',      true), ''), '-1')::bigint;
  seen             bigint;
  seen_id          uuid;
begin
  if current_user <> 'authenticated' then
    raise exception 'FAIL (CHECK 2): running as %, not authenticated — SET LOCAL did not take',
      current_user;
  end if;

  -- Vacuity guard: this whole check says "profile 2 sees none of profile 1's rows".
  -- With no rows of profile 1's to see, every zero below is free.
  if profiles_total < 2 then
    raise exception 'FAIL (CHECK 2): % profile row(s) exist — no other profile to be denied',
      profiles_total;
  end if;
  if collection_other < 1 or grants_other < 1 or loadouts_other < 1 or deck_cards_other < 1 then
    raise exception
      'FAIL (CHECK 2): nothing to hide — profile 1 holds % collection, % collection_grants, % loadouts, % loadout_deck_cards row(s); each must be at least 1 or the zeros below prove nothing',
      collection_other, grants_other, loadouts_other, deck_cards_other;
  end if;

  select count(*) into seen from public.profiles;
  select id into seen_id from public.profiles limit 1;
  if seen <> 1 or seen_id is distinct from caller then
    raise exception 'FAIL (CHECK 2): profiles showed % of % rows (first %), expected only %',
      seen, profiles_total, seen_id, caller;
  end if;

  select count(*) into seen from public.collection;
  if seen <> 0 then
    raise exception
      'FAIL (CHECK 2): collection showed % row(s) to a profile that owns none — profile 1s entitlements leaked',
      seen;
  end if;

  select count(*) into seen from public.collection_grants;
  if seen <> 0 then
    raise exception
      'FAIL (CHECK 2): collection_grants showed % row(s) to a profile that owns none — profile 1s ledger leaked',
      seen;
  end if;

  select count(*) into seen from public.loadouts;
  if seen <> 0 then
    raise exception
      'FAIL (CHECK 2): loadouts showed % row(s) to a profile that has none — profile 1s loadout leaked',
      seen;
  end if;

  select count(*) into seen from public.loadout_deck_cards;
  if seen <> 0 then
    raise exception
      'FAIL (CHECK 2): loadout_deck_cards showed % row(s) to a profile that has none — profile 1s decklist leaked, which SPEC §9.8 lists as data that never leaves the server',
      seen;
  end if;

  if decks_other < 1 or trios_other < 1 then
    raise exception 'FAIL (CHECK 2): nothing to hide — % foreign decks, % foreign trios', decks_other, trios_other;
  end if;
  select count(*) into seen from public.decks;
  if seen <> 0 then
    raise exception
      'FAIL (CHECK 2): decks showed % row(s) to a profile that has saved none — another profile''s decklist leaked',
      seen;
  end if;
  select count(*) into seen from public.trios;
  if seen <> 0 then
    raise exception 'FAIL (CHECK 2): trios showed % row(s) to a profile that has saved none', seen;
  end if;

  raise notice 'OK (CHECK 2): profile 2 sees only its own profile row; % foreign rows across collection/grants/loadouts/deck cards/decks/trios stayed hidden',
    collection_other + grants_other + loadouts_other + deck_cards_other + decks_other + trios_other;
end $$;

reset role;
rollback;

\echo '### tables the client must not reach at all ###'
begin;

-- The failure this guards against is a table that is refused because it is *missing* or
-- because the whole schema became unreachable, rather than because the client has no
-- grant on it. So: prove each table exists first (as superuser), and prove in the same
-- authenticated session that an allowed table still answers.
do $$
declare
  t text;
  missing text := '';
begin
  foreach t in array array['invite_codes', 'code_attempts', 'matches', 'match_actions', 'series'] loop
    if to_regclass('public.' || t) is null then
      missing := missing || t || ' ';
    end if;
  end loop;
  perform set_config('rls3.missing', missing, true);
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
do $$
declare
  -- `series` (0009, R263): both sides' frozen trios and both current picks, which R259 keeps
  -- hidden until both have picked — the same reason `matches` is here.
  forbidden constant text[] := array['invite_codes', 'code_attempts', 'matches', 'match_actions', 'series'];
  missing   text := coalesce(current_setting('rls3.missing', true), 'unknown');
  t         text;
  n         bigint;
  readable  bigint;
begin
  if current_user <> 'authenticated' then
    raise exception 'FAIL (CHECK 3): running as %, not authenticated — SET LOCAL did not take',
      current_user;
  end if;
  if btrim(missing) <> '' then
    raise exception
      'FAIL (CHECK 3): table(s) % do not exist, so "the client cannot reach them" is true for the wrong reason',
      btrim(missing);
  end if;

  -- Vacuity guard: the client must still be able to read something, or "refused" below
  -- only means the schema as a whole is unreachable from this session.
  select count(*) into readable from public.cards;
  if readable < 1 then
    raise exception
      'FAIL (CHECK 3): this session can read no rows of public.cards either — the refusals below are not specific to the forbidden tables';
  end if;

  foreach t in array forbidden loop
    begin
      execute format('select count(*) from public.%I', t) into n;
      raise exception
        'FAIL (CHECK 3): authenticated read public.% (% rows) — SPEC §9.1/§9.8 put this table outside the trust boundary',
        t, n;
    exception
      when insufficient_privilege then
        raise notice 'OK (CHECK 3): public.% refused (insufficient_privilege, %)', t, sqlstate;
      when others then
        -- Never `raise notice` here: a dropped table, a renamed schema or a broken policy
        -- would otherwise read as a refusal. Only 42501 is a refusal.
        if sqlerrm like 'FAIL%' then raise; end if;
        raise exception
          'FAIL (CHECK 3): public.% raised "%" (%), not insufficient_privilege — it is not being refused, it is missing or broken',
          t, sqlerrm, sqlstate;
    end;
  end loop;

  raise notice 'OK (CHECK 3): all % forbidden tables refused while public.cards stayed readable (% rows)',
    cardinality(forbidden), readable;
end $$;

reset role;
rollback;

\echo '### client write attempts must all fail ###'
begin;

-- Vacuity guard, in two parts.
--
-- Part one: every statement the client is about to attempt is run here first as the
-- table owner, inside a plpgsql subtransaction that is then rolled back. If the owner
-- cannot run it either, the statement is malformed or violates a constraint, and the
-- client's refusal below would say nothing about privileges. That is the difference
-- between "the client may not write this" and "nobody could have written this".
--
-- Part two: the two app.* functions must exist. A missing function raises
-- undefined_function, not insufficient_privilege, and the handlers below fail on it —
-- but naming it here makes the diagnosis immediate.
do $$
begin
  begin
    insert into public.collection (profile_id, card_id, quantity)
    values ('22222222-2222-2222-2222-222222222222', 'core-001', 99);
    update public.profiles set status = 'active'
     where id = '22222222-2222-2222-2222-222222222222';
    insert into public.loadout_deck_cards (profile_id, slot, card_id, count)
    values ('11111111-1111-1111-1111-111111111111', 2, 'core-002', 1);
    insert into public.decks (id, profile_id, name, cards, catalog_version)
    values ('d2000000-0000-4000-8000-000000000009', '22222222-2222-2222-2222-222222222222',
            'Planted', '[]', 'core-1');
    update public.trios set name = 'Renamed';
    delete from public.decks;
    insert into public.series (id, p1_profile_id, p2_profile_id, status, next_match_id, version,
                               catalog_version, state)
    values ('f2000000-0000-4000-8000-000000000009', '22222222-2222-2222-2222-222222222222',
            '11111111-1111-1111-1111-111111111111', 'picking',
            'f2000000-0000-4000-8000-00000000000a', 1, 'core-1', '{}');
    -- Undo the control by aborting this subtransaction; everything above is discarded.
    raise exception 'owner-control-rollback';
  exception when others then
    if sqlerrm <> 'owner-control-rollback' then
      raise exception
        'FAIL (CHECK 4): the owner could not run the statements the client is about to be refused ("%", %) — the refusals below would prove nothing about privileges',
        sqlerrm, sqlstate;
    end if;
  end;

  if to_regprocedure('app.redeem_invite_code(uuid, text, text)') is null then
    raise exception 'FAIL (CHECK 4): app.redeem_invite_code(uuid, text, text) does not exist';
  end if;
  if to_regprocedure('app.save_loadout(uuid, text, jsonb)') is null then
    raise exception 'FAIL (CHECK 4): app.save_loadout(uuid, text, jsonb) does not exist';
  end if;
  if to_regprocedure('app.upsert_deck(uuid, uuid, text, jsonb, text, timestamptz, int)') is null then
    raise exception 'FAIL (CHECK 4): app.upsert_deck(uuid, uuid, text, jsonb, text, timestamptz, int) does not exist';
  end if;
  if to_regprocedure('app.upsert_trio(uuid, uuid, text, uuid, uuid, uuid, timestamptz, int)') is null then
    raise exception 'FAIL (CHECK 4): app.upsert_trio(uuid, uuid, text, uuid, uuid, uuid, timestamptz, int) does not exist';
  end if;

  raise notice 'OK (CHECK 4 preflight): the owner can run all seven writes, and all four app.* functions exist';
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
do $$
declare
  readable bigint;
begin
  if current_user <> 'authenticated' then
    raise exception 'FAIL (CHECK 4): running as %, not authenticated — SET LOCAL did not take',
      current_user;
  end if;

  -- SPEC §9.4: "no client path writes either." Each probe asserts the *specific*
  -- refusal — sqlstate 42501, insufficient_privilege — and treats anything else as a
  -- failure, so a missing table, a broken constraint or a function raising its own
  -- error can never be mistaken for the privilege system doing its job.

  -- collection: readable (RLS-filtered) but never writable.
  select count(*) into readable from public.collection;
  begin
    insert into public.collection (profile_id, card_id, quantity)
    values ('22222222-2222-2222-2222-222222222222', 'core-001', 99);
    raise exception
      'FAIL (CHECK 4): collection INSERT succeeded — every collection change must go through app.grant_cards';
  exception
    when insufficient_privilege then
      if sqlerrm not like '%collection%' then
        raise exception 'FAIL (CHECK 4): collection INSERT was refused by "%" (%), which does not name the table',
          sqlerrm, sqlstate;
      end if;
      raise notice 'OK (CHECK 4): collection INSERT refused — % (%)', sqlerrm, sqlstate;
    when others then
      if sqlerrm like 'FAIL%' then raise; end if;
      raise exception
        'FAIL (CHECK 4): collection INSERT raised "%" (%), not insufficient_privilege — it was not the privilege system that refused it',
        sqlerrm, sqlstate;
  end;

  -- profiles: SPEC §9.1 "Profile status | Server only" — a client cannot activate itself.
  begin
    update public.profiles set status = 'active'
     where id = '22222222-2222-2222-2222-222222222222';
    raise exception
      'FAIL (CHECK 4): profiles UPDATE succeeded — a pending account activated itself without a code';
  exception
    when insufficient_privilege then
      if sqlerrm not like '%profiles%' then
        raise exception 'FAIL (CHECK 4): profiles UPDATE was refused by "%" (%), which does not name the table',
          sqlerrm, sqlstate;
      end if;
      raise notice 'OK (CHECK 4): profiles UPDATE refused — % (%)', sqlerrm, sqlstate;
    when others then
      if sqlerrm like 'FAIL%' then raise; end if;
      raise exception
        'FAIL (CHECK 4): profiles UPDATE raised "%" (%), not insufficient_privilege',
        sqlerrm, sqlstate;
  end;

  -- loadout_deck_cards: SPEC §9.1 "Loadout | Server validates and stores | Propose".
  -- The row targets profile 1 from profile 2's session, so this is also the cross-account
  -- write; the privilege check refuses it before RLS is ever consulted.
  begin
    insert into public.loadout_deck_cards (profile_id, slot, card_id, count)
    values ('11111111-1111-1111-1111-111111111111', 2, 'core-002', 1);
    raise exception
      'FAIL (CHECK 4): loadout_deck_cards INSERT succeeded — and it wrote another profiles deck';
  exception
    when insufficient_privilege then
      if sqlerrm not like '%loadout_deck_cards%' then
        raise exception 'FAIL (CHECK 4): loadout_deck_cards INSERT was refused by "%" (%), which does not name the table',
          sqlerrm, sqlstate;
      end if;
      raise notice 'OK (CHECK 4): loadout_deck_cards INSERT refused — % (%)', sqlerrm, sqlstate;
    when others then
      if sqlerrm like 'FAIL%' then raise; end if;
      raise exception
        'FAIL (CHECK 4): loadout_deck_cards INSERT raised "%" (%), not insufficient_privilege',
        sqlerrm, sqlstate;
  end;

  -- The privileged functions live in schema `app`. `authenticated` keeps USAGE on that
  -- schema for exactly one reason (0001: the RLS policies of 0002-0004 resolve
  -- app.current_profile_id() through it), so what refuses these two calls is the
  -- per-function EXECUTE denial, and the message names the function. Asserting that text
  -- separates "EXECUTE was revoked from this function" from "the function ran and raised
  -- an error of its own", which is what a bare `when others` would accept.
  begin
    perform app.redeem_invite_code('22222222-2222-2222-2222-222222222222', 'x', 'y');
    raise exception
      'FAIL (CHECK 4): app.redeem_invite_code is callable by a client — the invite gate is bypassable';
  exception
    when insufficient_privilege then
      if sqlerrm not like '%redeem_invite_code%' then
        raise exception
          'FAIL (CHECK 4): app.redeem_invite_code was refused by "%" (%), which does not name the function — that is not the revoked EXECUTE',
          sqlerrm, sqlstate;
      end if;
      raise notice 'OK (CHECK 4): app.redeem_invite_code refused — % (%)', sqlerrm, sqlstate;
    when others then
      if sqlerrm like 'FAIL%' then raise; end if;
      raise exception
        'FAIL (CHECK 4): app.redeem_invite_code raised "%" (%), not insufficient_privilege — the function ran',
        sqlerrm, sqlstate;
  end;

  begin
    perform app.save_loadout('22222222-2222-2222-2222-222222222222', 'core-1', '[]'::jsonb);
    raise exception
      'FAIL (CHECK 4): app.save_loadout is callable by a client — L1-L6 can be skipped by calling it directly';
  exception
    when insufficient_privilege then
      if sqlerrm not like '%save_loadout%' then
        raise exception
          'FAIL (CHECK 4): app.save_loadout was refused by "%" (%), which does not name the function — that is not the revoked EXECUTE',
          sqlerrm, sqlstate;
      end if;
      raise notice 'OK (CHECK 4): app.save_loadout refused — % (%)', sqlerrm, sqlstate;
    when others then
      if sqlerrm like 'FAIL%' then raise; end if;
      raise exception
        'FAIL (CHECK 4): app.save_loadout raised "%" (%), not insufficient_privilege — the function ran',
        sqlerrm, sqlstate;
  end;

  -- 0007 and 0009 (R250, R252, R263): a deck, a trio and a series are written by the server
  -- alone. Each statement below is one the owner ran in the preflight, so a refusal here is
  -- the privilege system and nothing else. The deck INSERT plants a row for profile 2 from
  -- profile 2's own session — refused all the same: there is no client write path at all, not
  -- merely none into another profile's rows.
  declare
    probe  text;
    probes constant text[][] := array[
      ['decks INSERT',
       $q$insert into public.decks (id, profile_id, name, cards, catalog_version)
          values ('d2000000-0000-4000-8000-000000000009', '22222222-2222-2222-2222-222222222222',
                  'Planted', '[]', 'core-1')$q$,
       'decks'],
      ['trios UPDATE', $q$update public.trios set name = 'Renamed'$q$, 'trios'],
      ['decks DELETE', $q$delete from public.decks$q$, 'decks'],
      ['series INSERT',
       $q$insert into public.series (id, p1_profile_id, p2_profile_id, status, next_match_id,
                                     version, catalog_version, state)
          values ('f2000000-0000-4000-8000-000000000009', '22222222-2222-2222-2222-222222222222',
                  '11111111-1111-1111-1111-111111111111', 'picking',
                  'f2000000-0000-4000-8000-00000000000a', 1, 'core-1', '{}')$q$,
       'series'],
      ['app.upsert_deck',
       $q$select app.upsert_deck('22222222-2222-2222-2222-222222222222',
                                 'd2000000-0000-4000-8000-000000000009', 'Mine', '[]', 'core-1',
                                 now(), 10)$q$,
       'upsert_deck'],
      ['app.upsert_trio',
       $q$select app.upsert_trio('22222222-2222-2222-2222-222222222222',
                                 'e2000000-0000-4000-8000-000000000009', 'Mine', null, null, null,
                                 now(), 5)$q$,
       'upsert_trio']];
    i int;
  begin
    for i in 1 .. array_length(probes, 1) loop
      probe := probes[i][1];
      begin
        execute probes[i][2];
        raise exception 'FAIL (CHECK 4): % succeeded as a client — decks, trios and series are written by the server alone',
          probe;
      exception
        when insufficient_privilege then
          if sqlerrm not like '%' || probes[i][3] || '%' then
            raise exception 'FAIL (CHECK 4): % was refused by "%" (%), which does not name %',
              probe, sqlerrm, sqlstate, probes[i][3];
          end if;
          raise notice 'OK (CHECK 4): % refused — % (%)', probe, sqlerrm, sqlstate;
        when others then
          if sqlerrm like 'FAIL%' then raise; end if;
          raise exception 'FAIL (CHECK 4): % raised "%" (%), not insufficient_privilege',
            probe, sqlerrm, sqlstate;
      end;
    end loop;
  end;

  -- Nothing above may have landed. The eleven probes all ran in this one transaction, so a
  -- write that slipped through is still visible here.
  if (select count(*) from public.collection) <> readable then
    raise exception 'FAIL (CHECK 4): the collection this session can see changed from % rows — a client write landed',
      readable;
  end if;

  raise notice 'OK (CHECK 4): 7 table writes and 4 app.* calls all refused with insufficient_privilege';
end $$;

reset role;
rollback;

\echo '### R320: a player reads only its own tutorial progress and writes none of it ###'
begin;

-- 0011's table, one row for EACH profile: profile 2's is the row to hide from profile 1 (and
-- profile 1's from profile 2), and each profile's own is the row it must still see. Raw inserts,
-- as superuser, because the point is what RLS shows, not how a row got there.
insert into public.tutorial_progress (profile_id, completed, hidden, hidden_at) values
  ('11111111-1111-1111-1111-111111111111', '{basics}', null, null),
  ('22222222-2222-2222-2222-222222222222', '{basics,spells}', true, '2026-01-01 00:00:00+00');

-- Preflight: every write the client is about to be refused is one the owner can make, inside a
-- subtransaction rolled back at once, so each refusal below is the privilege system and nothing
-- else (CHECK 4's reasoning). The merge is called for profile 1, which is active.
do $$
begin
  begin
    insert into public.tutorial_progress (profile_id, completed)
    values ('11111111-1111-1111-1111-111111111111', '{traps}')
    on conflict (profile_id) do update set completed = excluded.completed;
    update public.tutorial_progress set completed = '{}';
    delete from public.tutorial_progress;
    perform app.merge_tutorial_progress('11111111-1111-1111-1111-111111111111', '{traps}', null, null,
                                        now(), 32);
    raise exception 'owner-control-rollback';
  exception when others then
    if sqlerrm <> 'owner-control-rollback' then
      raise exception
        'FAIL (R320): the owner could not run the writes the client is about to be refused ("%", %) — the refusals below would prove nothing about privileges',
        sqlerrm, sqlstate;
    end if;
  end;
  perform set_config('rls5.total', (select count(*) from public.tutorial_progress)::text, true);
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);

\echo '-- tutorial_progress as profile 1: must be 1 (its own row only)'
select count(*) as tutorial_visible from public.tutorial_progress;

do $$
declare
  caller constant uuid := '11111111-1111-1111-1111-111111111111';
  total  bigint := coalesce(nullif(current_setting('rls5.total', true), ''), '-1')::bigint;
  seen   bigint;
  probe  text;
  probes constant text[][] := array[
    ['tutorial_progress INSERT',
     $q$insert into public.tutorial_progress (profile_id, completed)
        values ('11111111-1111-1111-1111-111111111111', '{traps}')
        on conflict (profile_id) do update set completed = excluded.completed$q$,
     'tutorial_progress'],
    ['tutorial_progress UPDATE', $q$update public.tutorial_progress set completed = '{}'$q$, 'tutorial_progress'],
    ['tutorial_progress DELETE', $q$delete from public.tutorial_progress$q$, 'tutorial_progress'],
    ['app.merge_tutorial_progress',
     $q$select app.merge_tutorial_progress('11111111-1111-1111-1111-111111111111', '{traps}', null, null,
                                           now(), 32)$q$,
     'merge_tutorial_progress']];
  i int;
begin
  if current_user <> 'authenticated' then
    raise exception 'FAIL (R320): running as %, not authenticated — SET LOCAL did not take', current_user;
  end if;
  -- Vacuity guard: two rows, one of them another profile's, or "sees only its own" is free.
  if total <> 2 then
    raise exception 'FAIL (R320): % tutorial_progress rows to measure against, expected 2 (one per profile)', total;
  end if;

  select count(*) into seen from public.tutorial_progress;
  if seen <> 1 or exists (select 1 from public.tutorial_progress where profile_id <> caller) then
    raise exception 'FAIL (R320): profile 1 saw % of % tutorial_progress rows — another profile''s progress leaked',
      seen, total;
  end if;
  if (select completed from public.tutorial_progress) <> '{basics}'::text[] then
    raise exception 'FAIL (R320): profile 1''s own row reads back as %', (select completed from public.tutorial_progress);
  end if;

  -- SPEC §9.1: no client write path at all — not into another profile's row, and not into its own.
  for i in 1 .. array_length(probes, 1) loop
    probe := probes[i][1];
    begin
      execute probes[i][2];
      raise exception 'FAIL (R320): % succeeded as a client — tutorial progress is written by the server alone', probe;
    exception
      when insufficient_privilege then
        if sqlerrm not like '%' || probes[i][3] || '%' then
          raise exception 'FAIL (R320): % was refused by "%" (%), which does not name %',
            probe, sqlerrm, sqlstate, probes[i][3];
        end if;
        raise notice 'OK (R320): % refused — % (%)', probe, sqlerrm, sqlstate;
      when others then
        if sqlerrm like 'FAIL%' then raise; end if;
        raise exception 'FAIL (R320): % raised "%" (%), not insufficient_privilege', probe, sqlerrm, sqlstate;
    end;
  end loop;

  raise notice 'OK (R320): profile 1 sees its own tutorial row and not profile 2''s, and 3 writes and the merge were refused';
end $$;

-- And the other way round: profile 2 sees its own row, never profile 1's.
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
do $$
declare
  seen bigint;
begin
  if current_user <> 'authenticated' then
    raise exception 'FAIL (R320): running as %, not authenticated', current_user;
  end if;
  select count(*) into seen from public.tutorial_progress;
  if seen <> 1 or exists (
    select 1 from public.tutorial_progress where profile_id <> '22222222-2222-2222-2222-222222222222'
  ) then
    raise exception 'FAIL (R320): profile 2 saw % tutorial_progress rows, expected only its own', seen;
  end if;
  raise notice 'OK (R320): profile 2 sees only its own tutorial row';
end $$;

reset role;
rollback;

\echo '### ALL RLS CHECKS RAN ###'
