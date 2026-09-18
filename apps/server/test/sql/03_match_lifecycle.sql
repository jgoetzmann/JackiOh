-- The room-code match path end to end, as the server (postgres/service_role)
-- would drive it. Runs after 01_schema_invariants.sql, which left profile 1 active with
-- a two-card collection and profile 2 pending, and after 02_rls_as_client.sql, which
-- rolled back everything it touched.
\set ON_ERROR_STOP on

-- Every check below must FAIL LOUDLY when the invariant in its heading is violated. A
-- `select` that prints rows is a diagnostic, never the check: psql prints the value and
-- moves on whether the answer was right or wrong. So each heading keeps its `select` for
-- the human reading the log, and follows it with a `do $$ ... raise exception
-- 'FAIL (CHECK n): ...' $$` block that is the actual assertion, exactly as
-- 01_schema_invariants.sql does. `raise exception` plus `\set ON_ERROR_STOP on` makes
-- psql exit non-zero, which run.sh turns into a non-zero exit for the whole suite;
-- `raise notice 'FAIL ...'` does NOT stop psql, so inside this file the FAIL path is
-- always `raise exception`.
--
-- Two rules this file follows, both learned from the way it used to pass everything:
--
--   * a `when others` handler is never the proof. `exception when others then raise
--     notice 'OK: %', sqlerrm` accepts ANY error as evidence of the one it claims: with
--     app.save_loadout replaced by a body that does nothing but `raise exception 'boom'`
--     this file printed "OK (L2/L1): boom" three times and the suite exited 0. Every
--     probe below compares sqlerrm against the exact expected message, or reads the
--     constraint name with GET STACKED DIAGNOSTICS, and treats anything else as a
--     failure — the same shape as 01's CHECK 14 and CHECK 15.
--
--   * a check that can be trivially true carries a vacuity guard. "No rows", "nothing
--     changed" and "it was refused" are all free when there was nothing there to begin
--     with, or when the function under test refuses everything. CHECK 2 is the single
--     biggest one: it saves a real, legal loadout, so every rejection after it is known
--     to be a rejection of that payload rather than of all payloads.
--
-- psql does not substitute :variables inside a dollar-quoted body, so every id a \gset
-- captures is also stashed in a session GUC that the assertion blocks read back with
-- current_setting. The trailing \gset on those set_config calls only keeps the stash out
-- of the printed log.

\echo '### activate profile 2 so both players can queue and play ###'
-- CHECK 1. Everything after this depends on profile 2 being active, so the redemption is
-- asserted rather than eyeballed: a silent 'not_pending' here would turn every later
-- check into a test of an unreachable path.
update auth.users set email_confirmed_at = now()
 where id = '22222222-2222-2222-2222-222222222222';
do $$
declare
  p2 constant uuid := '22222222-2222-2222-2222-222222222222';
  v_status_before text;
  v_uses_before   int;
  v_max_uses      int;
  v_redeemed      text;
  v_status_after  text;
  v_uses_after    int;
begin
  select status into v_status_before from public.profiles where id = p2;
  select uses, max_uses into v_uses_before, v_max_uses
    from public.invite_codes where code_hash = 'hash-good';
  -- Vacuity guard: redemption can only prove anything from a pending profile holding an
  -- unspent use of the code. 01 spent one of hash-goods two uses on profile 1.
  if v_status_before is distinct from 'pending' then
    raise exception 'FAIL (CHECK 1): profile 2 is already status=%, so its redemption proves nothing',
      coalesce(v_status_before, '(no profile)');
  end if;
  if v_uses_before is null or v_uses_before >= v_max_uses then
    raise exception 'FAIL (CHECK 1): hash-good has % of its % uses spent — nothing left to redeem',
      coalesce(v_uses_before::text, '(missing)'), coalesce(v_max_uses::text, '(missing)');
  end if;

  -- Side-effecting and rate-limited (SPEC §9.4 logs an attempt and counts it against the
  -- 5-per-hour limit), so it is called exactly once and its answer raised as a notice
  -- rather than re-run for a printable table — 01 CHECK 9/10s idiom.
  v_redeemed := app.redeem_invite_code(p2, 'hash-good', 'ip-b');
  raise notice 'CHECK 1: redeem_p2=%', v_redeemed;
  if v_redeemed <> 'ok' then
    raise exception 'FAIL (CHECK 1): profile 2 redemption returned "%", expected ok', v_redeemed;
  end if;

  select status into v_status_after from public.profiles where id = p2;
  select uses into v_uses_after from public.invite_codes where code_hash = 'hash-good';
  if v_status_after <> 'active' then
    raise exception 'FAIL (CHECK 1): profile 2 is status=% after a successful redemption', v_status_after;
  end if;
  if v_uses_after <> v_uses_before + 1 then
    raise exception 'FAIL (CHECK 1): hash-good went from % to % uses, expected exactly one more',
      v_uses_before, v_uses_after;
  end if;
  if not exists (select 1 from public.code_attempts where profile_id = p2 and succeeded) then
    raise exception 'FAIL (CHECK 1): the successful redemption was not logged in code_attempts';
  end if;
  if not exists (select 1 from public.collection where profile_id = p2) then
    raise exception 'FAIL (CHECK 1): activation granted profile 2 no cards — the launch-grant trigger did not fire';
  end if;
end $$;
select id, status, current_match_id is null as not_in_match from public.profiles order by id;

\echo '### save_loadout: a legal loadout of 3 decks x 20 cards saves ###'
-- CHECK 2, and the vacuity guard for CHECKs 3, 4 and 5: a save_loadout that refuses
-- everything — the `raise exception 'boom'` mutation, a dropped dependency, a broken
-- setting read — cannot get past this one. Every rejection below is then known to be a
-- rejection of its payload and not of all payloads.
--
-- SPEC §9.4 L2 is DECK_SIZE = 20 and L3 is MAX_COPIES = 1, so a legal loadout needs 60
-- distinct non-Token cards. 01 seeded three cards (two of them non-Token) because its
-- checks are about the schema; this fills the catalog out to 60 non-Token cards and
-- grants them through app.grant_launch_collection — the same path CHECK 20 (R111) then
-- re-runs to prove idempotent.
insert into public.cards (id, card_index, name, set_id, type, tags, rarity, token, cost,
                          catalog_version)
select format('bulk-%s', to_char(n, 'FM000')), n::text, format('Bulk %s', n), 'Core',
       'Unit', '{}'::text[], 'Common', false, to_jsonb(1), 'core-1'
  from generate_series(1, 58) as n;
select app.grant_launch_collection('11111111-1111-1111-1111-111111111111');
select count(*) as non_token_catalog from public.cards
 where token = false and catalog_version = 'core-1';
select count(*) as owned_cards, min(quantity) as min_quantity, max(quantity) as max_quantity
  from public.collection where profile_id = '11111111-1111-1111-1111-111111111111';
do $$
declare
  p1 constant uuid := '11111111-1111-1111-1111-111111111111';
  v_catalog bigint;
  v_owned   bigint;
  v_decks   jsonb;
  v_rows    bigint;
  v_slots   text;
  v_distinct bigint;
begin
  select count(*) into v_catalog from public.cards
   where token = false and catalog_version = 'core-1';
  if v_catalog <> 60 then
    raise exception
      'FAIL (CHECK 2): the core-1 catalog holds % non-Token cards, expected 60 — a legal loadout of 3 x DECK_SIZE(20) disjoint decks cannot be built',
      v_catalog;
  end if;
  select count(*) into v_owned from public.collection where profile_id = p1 and quantity >= 1;
  if v_owned <> v_catalog then
    raise exception
      'FAIL (CHECK 2): profile 1 owns % of the % non-Token cards — app.grant_launch_collection did not grant the new ones',
      v_owned, v_catalog;
  end if;

  -- 60 cards, ordered by id, cut into three decks of 20. One copy of each (L3), and no
  -- card in two decks (L4), so the only thing being tested is that a legal loadout saves.
  with ranked as (
    select c.id, row_number() over (order by c.id) as rn
      from public.cards c
     where c.token = false and c.catalog_version = 'core-1'
  ), decks as (
    select ((rn - 1) / 20) + 1 as slot,
           jsonb_build_object(
             'name', 'Deck ' || (((rn - 1) / 20) + 1),
             'cards', jsonb_agg(jsonb_build_object('card_id', id, 'count', 1) order by id)
           ) as deck
      from ranked
     group by ((rn - 1) / 20) + 1
  )
  select jsonb_agg(deck order by slot) into v_decks from decks;

  if jsonb_array_length(v_decks) <> 3 then
    raise exception 'FAIL (CHECK 2): built % decks, expected 3', jsonb_array_length(v_decks);
  end if;
  -- CHECK 4 re-uses this payload with one card moved, so it is stashed rather than rebuilt.
  perform set_config('mlc.legal_decks', v_decks::text, false);

  begin
    perform app.save_loadout(p1, 'core-1', v_decks);
  exception when others then
    -- Not a proof: this handler only turns a refusal into a named failure. A
    -- save_loadout that raises for every input dies here, and CHECKs 3, 4 and 5 below
    -- are never reached to mistake its error for the one each of them expects.
    raise exception
      'FAIL (CHECK 2): app.save_loadout refused a legal 3 x 20 loadout with "%" (%) — every rejection asserted below would then be a rejection of everything',
      sqlerrm, sqlstate;
  end;

  select count(*) into v_rows from public.loadouts where profile_id = p1;
  if v_rows <> 1 then
    raise exception 'FAIL (CHECK 2): % loadout root row(s) after a legal save, expected 1', v_rows;
  end if;
  select string_agg(slot::text, ',' order by slot) into v_slots
    from public.loadout_decks where profile_id = p1;
  if v_slots is distinct from '1,2,3' then
    raise exception 'FAIL (CHECK 2): deck slots are [%], expected [1,2,3] (SPEC §9.4 L1)',
      coalesce(v_slots, '(none)');
  end if;
  select count(*), count(distinct card_id) into v_rows, v_distinct
    from public.loadout_deck_cards where profile_id = p1;
  if v_rows <> 60 or v_distinct <> 60 then
    raise exception
      'FAIL (CHECK 2): the saved loadout holds % card rows over % distinct cards, expected 60 of each (L2 x 3 decks, L4 disjoint)',
      v_rows, v_distinct;
  end if;
  if exists (
    select 1 from public.loadout_deck_cards
     where profile_id = p1 group by slot having sum("count") <> 20
  ) then
    raise exception 'FAIL (CHECK 2): a saved deck does not hold exactly DECK_SIZE (20) cards';
  end if;

  raise notice 'OK (CHECK 2): app.save_loadout accepted a legal 3 x 20 loadout over a 60-card catalog';
end $$;
select slot, sum("count") as cards_in_deck from public.loadout_deck_cards
 where profile_id = '11111111-1111-1111-1111-111111111111' group by slot order by slot;

\echo '### save_loadout: L2 must reject a short deck ###'
-- CHECK 3. The exact message matters: `exception when others` here is what let a
-- save_loadout that raises 'boom' for every input read as a proof of L2.
do $$
declare
  p1 constant uuid := '11111111-1111-1111-1111-111111111111';
  expected constant text := 'loadout: L2 deck 1 has 1 cards, expected 20';
  v_decks jsonb := jsonb_build_array(
    jsonb_build_object('name', 'One',   'cards', jsonb_build_array(
      jsonb_build_object('card_id', 'core-001', 'count', 1))),
    jsonb_build_object('name', 'Two',   'cards', jsonb_build_array(
      jsonb_build_object('card_id', 'core-002', 'count', 1))),
    jsonb_build_object('name', 'Three', 'cards', '[]'::jsonb));
  v_before bigint;
  v_after  bigint;
begin
  select count(*) into v_before from public.loadout_deck_cards where profile_id = p1;
  begin
    perform app.save_loadout(p1, 'core-1', v_decks);
    raise exception 'FAIL (CHECK 3): a 1-card deck was accepted (SPEC §9.4 L2)';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm <> expected then
      raise exception
        'FAIL (CHECK 3): the short deck raised "%" (%), expected exactly "%" — any other error is not L2 refusing it',
        sqlerrm, sqlstate, expected;
    end if;
    raise notice 'OK (CHECK 3): %', sqlerrm;
  end;

  -- SPEC §9.4: "writes all three decks in one transaction or nothing." The legal loadout
  -- CHECK 2 saved must still be there, untouched, after a rejected save.
  select count(*) into v_after from public.loadout_deck_cards where profile_id = p1;
  if v_after <> v_before or v_before <> 60 then
    raise exception
      'FAIL (CHECK 3): the stored loadout went from % to % card rows across a rejected save (expected 60, unchanged)',
      v_before, v_after;
  end if;
end $$;

\echo '### save_loadout: a card in two decks must be rejected ###'
-- CHECK 4. What refuses this is L5, not L4, and the distinction is the whole point of
-- asserting the exact message. app.save_loadout checks L5 ("copies across the loadout
-- never exceed the quantity owned") before it inserts anything, and R111 grants exactly
-- one copy of each card, so a card placed in two decks is always over its owned quantity
-- and is refused before the loadout_card_unique index is ever consulted — SPEC §11 R141
-- says the same thing from the other side. L4's index is proved directly, by raw SQL
-- that bypasses this function entirely, in 01_schema_invariants.sql CHECK 14 (BUILD
-- M6-T3: "the unique index rejects a duplicate across decks even when the application
-- check is bypassed"). The payload here is CHECK 2's legal loadout with one card of
-- deck 2 replaced by a card of deck 1, so it differs from a saveable loadout in exactly
-- one way and nothing else can be what rejects it.
do $$
declare
  p1 constant uuid := '11111111-1111-1111-1111-111111111111';
  v_decks jsonb := nullif(current_setting('mlc.legal_decks', true), '')::jsonb;
  v_dup   text   := v_decks -> 0 -> 'cards' -> 0 ->> 'card_id';
  v_bad   jsonb;
  expected text;
  v_before bigint;
  v_after  bigint;
  v_cards  bigint;
begin
  if v_dup is null then
    raise exception 'FAIL (CHECK 4): CHECK 2 stashed no legal loadout to derive a duplicate from';
  end if;
  v_bad := jsonb_set(v_decks, '{1,cards,0,card_id}', to_jsonb(v_dup));
  expected := format('loadout: L5 card %s totals 2 copies across the loadout, only 1 owned', v_dup);

  -- Vacuity guards: the payload must really be the legal one plus a cross-deck duplicate,
  -- or the rejection below could be L2 or L3 talking.
  if v_bad = v_decks then
    raise exception 'FAIL (CHECK 4): the duplicate payload is identical to the legal one';
  end if;
  select sum((elem ->> 'count')::int) into v_cards
    from jsonb_array_elements(v_bad -> 1 -> 'cards') as elem;
  if v_cards <> 20 then
    raise exception 'FAIL (CHECK 4): deck 2 of the duplicate payload holds % cards, so L2 would reject it first',
      v_cards;
  end if;
  if (select count(*) from jsonb_array_elements(v_bad -> 1 -> 'cards') as elem
       where elem ->> 'card_id' = v_dup) <> 1 then
    raise exception 'FAIL (CHECK 4): % appears more than once inside deck 2, so L3 would reject it first',
      v_dup;
  end if;

  select count(*) into v_before from public.loadout_deck_cards where profile_id = p1;
  begin
    perform app.save_loadout(p1, 'core-1', v_bad);
    raise exception 'FAIL (CHECK 4): card % was accepted in two decks of one loadout', v_dup;
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm <> expected then
      raise exception
        'FAIL (CHECK 4): the cross-deck duplicate raised "%" (%), expected exactly "%"',
        sqlerrm, sqlstate, expected;
    end if;
    raise notice 'OK (CHECK 4): %', sqlerrm;
  end;

  select count(*) into v_after from public.loadout_deck_cards where profile_id = p1;
  if v_after <> v_before or v_before <> 60 then
    raise exception
      'FAIL (CHECK 4): the stored loadout went from % to % card rows across a rejected save (expected 60, unchanged)',
      v_before, v_after;
  end if;
end $$;

\echo '### R105: a stale catalog version is refused at save and queue ###'
-- CHECK 5. SPEC §9.4: "stale catalog version is rejected at save and queue." Both halves
-- are probed — app.save_loadout for the save, app.create_room for the queue side — and
-- both must raise exactly "update required", which is what 0002 raises so the API layer
-- can pass it through unchanged (BUILD M6-T2). Accepting any error at all would have let
-- "function does not exist" pass as a rejection.
do $$
declare
  p1 constant uuid := '11111111-1111-1111-1111-111111111111';
  v_matches_before bigint;
  v_matches_after  bigint;
begin
  begin
    perform app.save_loadout(p1, 'core-999', '[]'::jsonb);
    raise exception 'FAIL (CHECK 5): save_loadout accepted catalog version core-999';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm <> 'update required' then
      raise exception
        'FAIL (CHECK 5): a stale catalog version at save raised "%" (%), expected exactly "update required"',
        sqlerrm, sqlstate;
    end if;
    raise notice 'OK (CHECK 5, save): %', sqlerrm;
  end;

  select count(*) into v_matches_before from public.matches;
  begin
    perform app.create_room(p1, 'ABC999', 'seed-r105', '["core-001"]'::jsonb, 'core-999');
    raise exception 'FAIL (CHECK 5): create_room accepted catalog version core-999';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm <> 'update required' then
      raise exception
        'FAIL (CHECK 5): a stale catalog version at queue raised "%" (%), expected exactly "update required"',
        sqlerrm, sqlstate;
    end if;
    raise notice 'OK (CHECK 5, queue): %', sqlerrm;
  end;
  -- The version gate must run before anything is written.
  select count(*) into v_matches_after from public.matches;
  if v_matches_after <> v_matches_before then
    raise exception 'FAIL (CHECK 5): the refused create_room still left % new match row(s)',
      v_matches_after - v_matches_before;
  end if;
end $$;

\echo '### create_room -> join_room ###'
-- CHECK 6. Clear the loadout card rows CHECK 2 saved: the room path freezes decks into
-- the match at creation and never reads public.loadouts again (ARCHITECTURE §5.4), so the
-- rest of the file must not be able to lean on them.
delete from public.loadout_deck_cards
 where profile_id = '11111111-1111-1111-1111-111111111111';
do $$
begin
  perform set_config('mlc.matches_before', (select count(*) from public.matches)::text, false);
end $$;

select app.create_room(
  '11111111-1111-1111-1111-111111111111',
  'ABC234',
  'seed-bringup-1',
  '["core-001","core-002"]'::jsonb,
  'core-1') as match_id \gset
select set_config('mlc.match_id', :'match_id', false) as stashed \gset

select id, room_code, status, seed, p1_profile_id, p2_profile_id,
       ceiling_at = 'infinity'::timestamptz as ceiling_is_placeholder
  from public.matches where id = :'match_id';

do $$
declare
  p1 constant uuid := '11111111-1111-1111-1111-111111111111';
  p2 constant uuid := '22222222-2222-2222-2222-222222222222';
  v_match constant uuid := current_setting('mlc.match_id')::uuid;
  v_before bigint := coalesce(nullif(current_setting('mlc.matches_before', true), ''), '-1')::bigint;
  m record;
  n bigint;
begin
  -- Vacuity guard: create_room must have created a row that was not there before, or
  -- every column assertion below is about some pre-existing match.
  select count(*) into n from public.matches;
  if v_before < 0 or n <> v_before + 1 then
    raise exception 'FAIL (CHECK 6): matches went from % to % rows, expected exactly one new room', v_before, n;
  end if;

  select * into m from public.matches where id = v_match;
  if not found then
    raise exception 'FAIL (CHECK 6): create_room returned % but no such match row exists', v_match;
  end if;
  if m.status <> 'open' then
    raise exception 'FAIL (CHECK 6): a new room is status=%, expected open (SPEC §9.5)', m.status;
  end if;
  if m.room_code is distinct from 'ABC234' or m.seed is distinct from 'seed-bringup-1' then
    raise exception 'FAIL (CHECK 6): the room stored room_code=% seed=%', m.room_code, m.seed;
  end if;
  if m.p1_profile_id is distinct from p1 or m.p2_profile_id is not null then
    raise exception 'FAIL (CHECK 6): the room stored p1=% p2=%, expected p1 alone', m.p1_profile_id, m.p2_profile_id;
  end if;
  if m.ceiling_at is distinct from 'infinity'::timestamptz then
    raise exception
      'FAIL (CHECK 6): ceiling_at is %, expected the infinity placeholder — an open room must never be reaped',
      m.ceiling_at;
  end if;
  if m.started_at is not null or m.ended_at is not null or m.last_seq <> 0 then
    raise exception 'FAIL (CHECK 6): a waiting room has started_at=% ended_at=% last_seq=%',
      m.started_at, m.ended_at, m.last_seq;
  end if;
  if (select current_match_id from public.profiles where id = p1) is distinct from v_match then
    raise exception 'FAIL (CHECK 6): the host is not marked in the match it just created';
  end if;
  if (select current_match_id from public.profiles where id = p2) is not null then
    raise exception 'FAIL (CHECK 6): the second player is already marked in a match nobody joined';
  end if;
end $$;

\echo '-- joining your own room must be refused'
do $$
declare
  p1 constant uuid := '11111111-1111-1111-1111-111111111111';
  v_match constant uuid := current_setting('mlc.match_id')::uuid;
  expected constant text := 'app.join_room: cannot join your own room';
  m record;
begin
  -- Vacuity guard: the refusal must come from the self-join rule, not from a room that is
  -- already gone or already claimed.
  select status, p2_profile_id into m from public.matches where id = v_match;
  if m.status <> 'open' or m.p2_profile_id is not null then
    raise exception 'FAIL (CHECK 7): the room is status=% p2=% before the self-join probe', m.status, m.p2_profile_id;
  end if;

  begin
    perform app.join_room('ABC234', p1, '["core-001"]'::jsonb, 'core-1');
    raise exception 'FAIL (CHECK 7): the host joined its own room';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm <> expected then
      raise exception 'FAIL (CHECK 7): the self-join raised "%" (%), expected exactly "%"',
        sqlerrm, sqlstate, expected;
    end if;
    raise notice 'OK (CHECK 7): %', sqlerrm;
  end;

  select status, p2_profile_id into m from public.matches where id = v_match;
  if m.status <> 'open' or m.p2_profile_id is not null then
    raise exception 'FAIL (CHECK 7): the refused self-join still changed the room to status=% p2=%',
      m.status, m.p2_profile_id;
  end if;
end $$;

select app.join_room('ABC234', '22222222-2222-2222-2222-222222222222',
                     '["core-002","core-001"]'::jsonb, 'core-1') as joined_match_id \gset
select set_config('mlc.joined_match_id', :'joined_match_id', false) as stashed \gset
select :'joined_match_id'::uuid as joined_match_id;

select status, p2_profile_id is not null as p2_set,
       ceiling_at > now() as ceiling_stamped,
       started_at is not null as started
  from public.matches where id = :'match_id';

do $$
declare
  p2 constant uuid := '22222222-2222-2222-2222-222222222222';
  v_match constant uuid := current_setting('mlc.match_id')::uuid;
  v_joined constant uuid := current_setting('mlc.joined_match_id')::uuid;
  m record;
begin
  -- CHECK 8. The vacuity guard is CHECK 6/7, which asserted this room was still `open`
  -- with a placeholder ceiling right up to this call: every value below is a change.
  if v_joined is distinct from v_match then
    raise exception 'FAIL (CHECK 8): join_room returned %, not the room it claimed (%)', v_joined, v_match;
  end if;
  select * into m from public.matches where id = v_match;
  if m.status <> 'live' then
    raise exception 'FAIL (CHECK 8): the claimed room is status=%, expected live', m.status;
  end if;
  if m.p2_profile_id is distinct from p2 then
    raise exception 'FAIL (CHECK 8): p2 is %, expected %', m.p2_profile_id, p2;
  end if;
  if m.p2_deck is distinct from '["core-002","core-001"]'::jsonb then
    raise exception 'FAIL (CHECK 8): the joiners frozen deck was stored as %', m.p2_deck;
  end if;
  if m.started_at is null then
    raise exception 'FAIL (CHECK 8): a live match has no started_at';
  end if;
  -- R79: the real 60-minute ceiling is stamped from when the match went live.
  if m.ceiling_at is distinct from 'infinity'::timestamptz
     and (m.ceiling_at <= now() + interval '59 minutes'
          or m.ceiling_at >= now() + interval '61 minutes') then
    raise exception 'FAIL (CHECK 8): ceiling_at is %, expected roughly now + 60 minutes (R79)', m.ceiling_at;
  end if;
  if m.ceiling_at = 'infinity'::timestamptz then
    raise exception
      'FAIL (CHECK 8): ceiling_at is still the open-room placeholder — a live match that can never be reaped';
  end if;
end $$;

\echo '-- both players are marked in a match'
select id, current_match_id = :'match_id' as in_this_match
  from public.profiles order by id;
do $$
declare
  v_match constant uuid := current_setting('mlc.match_id')::uuid;
  n bigint;
begin
  -- CHECK 9. CHECK 6 asserted p2.current_match_id was null before the join, so this is a
  -- change and not a constant.
  select count(*) into n from public.profiles where current_match_id = v_match;
  if n <> 2 then
    raise exception
      'FAIL (CHECK 9): % of 2 players are marked in the match — SPEC §9.5 needs both, or a player can queue twice',
      n;
  end if;
  if exists (select 1 from public.profiles where current_match_id is distinct from v_match) then
    raise exception 'FAIL (CHECK 9): a profile is marked in some other match';
  end if;
end $$;

\echo '-- the room is no longer joinable'
do $$
declare
  p2 constant uuid := '22222222-2222-2222-2222-222222222222';
  v_match constant uuid := current_setting('mlc.match_id')::uuid;
  expected constant text := 'app.join_room: room ABC234 is no longer open';
  v_status text;
begin
  -- CHECK 10. Vacuity guard: the code must still resolve to a row, or "no longer open"
  -- would be indistinguishable from "room not found".
  select status into v_status from public.matches where room_code = 'ABC234' and status <> 'over';
  if v_status is null then
    raise exception 'FAIL (CHECK 10): no room carries the code ABC234 any more';
  end if;

  begin
    perform app.join_room('ABC234', p2, '["core-001"]'::jsonb, 'core-1');
    raise exception 'FAIL (CHECK 10): a live room was joined again';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm <> expected then
      raise exception 'FAIL (CHECK 10): the second join raised "%" (%), expected exactly "%"',
        sqlerrm, sqlstate, expected;
    end if;
    raise notice 'OK (CHECK 10): %', sqlerrm;
  end;

  if (select p2_profile_id from public.matches where id = v_match) is distinct from p2 then
    raise exception 'FAIL (CHECK 10): the refused join changed p2 on the live match';
  end if;
end $$;

\echo '### append_match_action: seq assignment and nonce dedupe ###'
do $$
begin
  perform set_config('mlc.actions_before',
    (select count(*) from public.match_actions
      where match_id = current_setting('mlc.match_id')::uuid)::text, false);
end $$;
select app.append_match_action(:'match_id', 'p1',
  '11111111-1111-1111-1111-111111111111', 'nonce-a',
  '{"type":"endTurn","playerId":"p1","nonce":"nonce-a"}'::jsonb) as seq_1 \gset
select :seq_1 as seq_1;
select app.append_match_action(:'match_id', 'p2',
  '22222222-2222-2222-2222-222222222222', 'nonce-b',
  '{"type":"endTurn","playerId":"p2","nonce":"nonce-b"}'::jsonb) as seq_2 \gset
select :seq_2 as seq_2;
\echo '-- the same nonce must return the original seq, not a new row'
select app.append_match_action(:'match_id', 'p1',
  '11111111-1111-1111-1111-111111111111', 'nonce-a',
  '{"type":"endTurn","playerId":"p1","nonce":"nonce-a"}'::jsonb) as seq_1_again \gset
select :seq_1_again as seq_1_again;
select count(*) as logged_actions, max(seq) as high_water from public.match_actions
 where match_id = :'match_id';
select last_seq from public.matches where id = :'match_id';
select set_config('mlc.seq_1', :'seq_1', false) as a,
       set_config('mlc.seq_2', :'seq_2', false) as b,
       set_config('mlc.seq_again', :'seq_1_again', false) as c \gset

do $$
declare
  v_match constant uuid := current_setting('mlc.match_id')::uuid;
  v_before bigint := coalesce(nullif(current_setting('mlc.actions_before', true), ''), '-1')::bigint;
  seq_1     bigint := coalesce(nullif(current_setting('mlc.seq_1',     true), ''), '-999')::bigint;
  seq_2     bigint := coalesce(nullif(current_setting('mlc.seq_2',     true), ''), '-999')::bigint;
  seq_again bigint := coalesce(nullif(current_setting('mlc.seq_again', true), ''), '-999')::bigint;
  logged   bigint;
  high     bigint;
  v_last_seq bigint;
  dupes    bigint;
begin
  -- CHECK 11. Vacuity guard: the log must have been empty for this match, or "2 rows
  -- after 3 calls" could be describing rows somebody else wrote.
  if v_before <> 0 then
    raise exception 'FAIL (CHECK 11): the action log already held % row(s) for this match', v_before;
  end if;

  -- SPEC §9.3: seq is per-match, monotonic and gapless, assigned by the function.
  if seq_1 <> 1 or seq_2 <> 2 then
    raise exception 'FAIL (CHECK 11): the first two appends returned seq % and %, expected 1 and 2',
      seq_1, seq_2;
  end if;
  -- BUILD M6-T4: "a v_reused nonce returns the original ack."
  if seq_again <> seq_1 then
    raise exception
      'FAIL (CHECK 11): the replayed nonce returned seq %, expected the original % — nonce dedupe is not returning the first ack',
      seq_again, seq_1;
  end if;

  select count(*), max(seq) into logged, high from public.match_actions where match_id = v_match;
  if logged <> 2 or high <> 2 then
    raise exception
      'FAIL (CHECK 11): the log holds % row(s) with high-water %, expected 2 and 2 — the replay wrote a second row, or nothing was logged at all',
      logged, high;
  end if;
  select count(*) into dupes from public.match_actions
   where match_id = v_match and nonce = 'nonce-a';
  if dupes <> 1 then
    raise exception 'FAIL (CHECK 11): nonce-a appears % times in the log, expected 1', dupes;
  end if;
  if not exists (
    select 1 from public.match_actions
     where match_id = v_match and nonce = 'nonce-a' and seq = seq_1 and player_seat = 'p1'
  ) then
    raise exception 'FAIL (CHECK 11): no p1 row with nonce-a at seq %', seq_1;
  end if;
  select m.last_seq into v_last_seq from public.matches m where m.id = v_match;
  if v_last_seq <> 2 then
    raise exception 'FAIL (CHECK 11): matches.last_seq is %, expected 2 — the high-water mark and the log disagree',
      v_last_seq;
  end if;
end $$;

\echo '-- a server action has no author'
select app.append_match_action(:'match_id', 'server', null, 'nonce-timeout',
  '{"type":"timeout"}'::jsonb) as seq_server \gset
select :seq_server as seq_server;
select set_config('mlc.seq_server', :'seq_server', false) as stashed \gset
do $$
declare
  v_match constant uuid := current_setting('mlc.match_id')::uuid;
  seq_server bigint := coalesce(nullif(current_setting('mlc.seq_server', true), ''), '-999')::bigint;
  r record;
begin
  -- CHECK 12. R79/SPEC §9.5: `timeout`, `disconnectExpired` and `ceilingReached` have no
  -- author, so player_id is null and player_seat is 'server'.
  if seq_server <> 3 then
    raise exception 'FAIL (CHECK 12): the server action took seq %, expected 3 after two player actions',
      seq_server;
  end if;
  select player_id, player_seat into r from public.match_actions
   where match_id = v_match and seq = seq_server;
  if not found then
    raise exception 'FAIL (CHECK 12): no log row at seq % — the server action was not recorded', seq_server;
  end if;
  if r.player_id is not null or r.player_seat <> 'server' then
    raise exception 'FAIL (CHECK 12): the server action was logged as player_id=% seat=%',
      r.player_id, r.player_seat;
  end if;
end $$;

\echo '### live_matches: what a restarting server folds ###'
select count(*) as live_matches from app.live_matches();
do $$
declare
  v_match constant uuid := current_setting('mlc.match_id')::uuid;
  folded  bigint;
  live    bigint;
begin
  -- CHECK 13. SPEC §9.5: a restarting server folds (seed, log) for every live match.
  -- The discrimination half of this check — that live_matches() leaves a non-live match
  -- out rather than returning the whole table — is asserted in CHECK 14, once this match
  -- is `over` and still in public.matches.
  select count(*) into folded from app.live_matches();
  select count(*) into live from public.matches where status = 'live';
  if live < 1 then
    raise exception 'FAIL (CHECK 13): no live match exists, so folding none of them proves nothing';
  end if;
  if folded <> live then
    raise exception 'FAIL (CHECK 13): live_matches() returned % row(s) for % live match(es)', folded, live;
  end if;
  if not exists (select 1 from app.live_matches() lm where lm.id = v_match) then
    raise exception 'FAIL (CHECK 13): live_matches() left out the live match a restarting server must rebuild';
  end if;
end $$;

\echo '### end_match: one result row, ratings moved, in-match state cleared ###'
do $$
declare
  v_match constant uuid := current_setting('mlc.match_id')::uuid;
  m record;
  n bigint;
begin
  -- Vacuity guards for CHECK 14, captured before the call: the match is live, nobody has
  -- a result for it yet, both players are marked in it, and both ratings are the 1000 the
  -- assertions below expect to see move.
  select status, p1_profile_id, p2_profile_id into m from public.matches where id = v_match;
  if m.status <> 'live' then
    raise exception 'FAIL (CHECK 14): the match is already status=% before end_match', m.status;
  end if;
  select count(*) into n from public.results where match_id = v_match;
  if n <> 0 then
    raise exception 'FAIL (CHECK 14): % result row(s) already exist for this match', n;
  end if;
  select count(*) into n from public.profiles where current_match_id = v_match;
  if n <> 2 then
    raise exception 'FAIL (CHECK 14): % players are marked in the match before it ends, expected 2', n;
  end if;
  select count(*) into n from public.profiles
   where id in (m.p1_profile_id, m.p2_profile_id) and rating = 1000;
  if n <> 2 then
    raise exception 'FAIL (CHECK 14): the players are not both at rating 1000 before the match ends';
  end if;
end $$;
select app.end_match(:'match_id', '11111111-1111-1111-1111-111111111111',
                     'hero-death', 14, 1016, 984);
select reason, winner_profile_id = '11111111-1111-1111-1111-111111111111' as p1_won,
       turns, p1_rating_before, p1_rating_after, p2_rating_before, p2_rating_after
  from public.results where match_id = :'match_id';
select status, ended_at is not null as ended from public.matches where id = :'match_id';
select id, current_match_id is null as cleared, rating from public.profiles order by id;
do $$
declare
  p1 constant uuid := '11111111-1111-1111-1111-111111111111';
  p2 constant uuid := '22222222-2222-2222-2222-222222222222';
  v_match constant uuid := current_setting('mlc.match_id')::uuid;
  r record;
  m record;
  n bigint;
begin
  select count(*) into n from public.results where match_id = v_match;
  if n <> 1 then
    raise exception 'FAIL (CHECK 14): % result row(s) for the ended match, expected exactly 1', n;
  end if;
  select * into r from public.results where match_id = v_match;
  if r.reason <> 'hero-death' or r.winner_profile_id is distinct from p1 or r.turns <> 14 then
    raise exception 'FAIL (CHECK 14): the result reads reason=% winner=% turns=%',
      r.reason, r.winner_profile_id, r.turns;
  end if;
  if r.p1_rating_before <> 1000 or r.p1_rating_after <> 1016
     or r.p2_rating_before <> 1000 or r.p2_rating_after <> 984 then
    raise exception 'FAIL (CHECK 14): the result recorded ratings %->% and %->%, expected 1000->1016 and 1000->984',
      r.p1_rating_before, r.p1_rating_after, r.p2_rating_before, r.p2_rating_after;
  end if;

  select status, ended_at into m from public.matches where id = v_match;
  if m.status <> 'over' or m.ended_at is null then
    raise exception 'FAIL (CHECK 14): the match is status=% ended_at=% after end_match', m.status, m.ended_at;
  end if;

  -- SPEC §9.5: "Every ending records a result and clears both players in-match state."
  select count(*) into n from public.profiles where current_match_id is not null;
  if n <> 0 then
    raise exception 'FAIL (CHECK 14): % profile(s) are still marked in a match — they cannot queue again', n;
  end if;
  if (select rating from public.profiles where id = p1) <> 1016
     or (select rating from public.profiles where id = p2) <> 984 then
    raise exception 'FAIL (CHECK 14): the profiles ratings were not moved to 1016 and 984';
  end if;

  -- The other half of CHECK 13: the match row is still there, and live_matches() now
  -- leaves it out. Without this, "live_matches() returned 1" is also what a function that
  -- returns every match would have said.
  if not exists (select 1 from public.matches where id = v_match) then
    raise exception 'FAIL (CHECK 14): the ended match row disappeared';
  end if;
  if exists (select 1 from app.live_matches() lm where lm.id = v_match) then
    raise exception
      'FAIL (CHECK 14): live_matches() still folds a match that is over — it is not filtering on status';
  end if;
end $$;

\echo '-- end_match must be idempotent'
do $$
declare
  v_match constant uuid := current_setting('mlc.match_id')::uuid;
  p1 constant uuid := '11111111-1111-1111-1111-111111111111';
  expected constant text :=
    'app.end_match: match 00000000-0000-0000-0000-000000000000 not found';
  ended_before timestamptz;
  ended_after  timestamptz;
  n bigint;
begin
  -- CHECK 15, part one: an unknown match is an error, not a silent no-op.
  begin
    perform app.end_match('00000000-0000-0000-0000-000000000000'::uuid,
                          null, 'match-ceiling', 0, 1000, 1000);
    raise exception 'FAIL (CHECK 15): end_match accepted a match id that does not exist';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm <> expected then
      raise exception 'FAIL (CHECK 15): an unknown match raised "%" (%), expected exactly "%"',
        sqlerrm, sqlstate, expected;
    end if;
    raise notice 'OK (CHECK 15): %', sqlerrm;
  end;

  -- Part two: a second ending of a match that is already over changes nothing. The
  -- vacuity guard is that there is something to change — one result row and two moved
  -- ratings, from CHECK 14.
  select ended_at into ended_before from public.matches where id = v_match;
  if ended_before is null then
    raise exception 'FAIL (CHECK 15): the match is not ended, so a repeat call proves no idempotence';
  end if;

  perform app.end_match(v_match, p1, 'hero-death', 14, 1016, 984);

  select count(*) into n from public.results where match_id = v_match;
  if n <> 1 then
    raise exception 'FAIL (CHECK 15): % result row(s) after a repeated end_match, expected 1', n;
  end if;
  select ended_at into ended_after from public.matches where id = v_match;
  if ended_after is distinct from ended_before then
    raise exception 'FAIL (CHECK 15): the repeat call restamped ended_at from % to %',
      ended_before, ended_after;
  end if;
  if (select rating from public.profiles where id = p1) <> 1016 then
    raise exception 'FAIL (CHECK 15): the repeat call moved the rating again';
  end if;
end $$;
select count(*) as result_rows from public.results where match_id = :'match_id';

-- R142: this is where R110 is verifiable at all. Nothing lets a client ask for a specific room
-- code, so the reuse is proved here — mint a code, finish its match, mint the same code again —
-- and the end-to-end suite asserts only the consequence (both players queue-eligible once the
-- match is over), which `end_match` above has just shown.
\echo '### R110: a room code is reusable once its match is over (R142) ###'
-- The reuse itself is the assertion, so it runs where a refusal can be named: a
-- `select` at the top level would only hand psql a raw index error.
do $$
declare
  p1 constant uuid := '11111111-1111-1111-1111-111111111111';
  v_new uuid;
begin
  begin
    v_new := app.create_room(p1, 'ABC234', 'seed-2', '["core-001"]'::jsonb, 'core-1');
  exception when others then
    raise exception
      'FAIL (CHECK 16): the code ABC234 could not be reissued after its match ended — create_room raised "%" (%); a room-code index that is not partial burns every code it ever mints',
      sqlerrm, sqlstate;
  end;
  perform set_config('mlc.reused_match', v_new::text, false);
end $$;
select current_setting('mlc.reused_match')::uuid as reused_code_match;
select status, count(*) as rooms_with_this_code from public.matches
 where room_code = 'ABC234' group by status order by status;
do $$
declare
  p1 constant uuid := '11111111-1111-1111-1111-111111111111';
  v_match constant uuid := current_setting('mlc.match_id')::uuid;
  v_reused constant uuid := current_setting('mlc.reused_match')::uuid;
  refused_by text;
  n bigint;
begin
  -- CHECK 16. Vacuity guard: reuse means nothing unless the first holder of the code is
  -- still on the table and finished. If the old row were gone, or still open, reissuing
  -- the code would prove nothing about the *partial* index.
  select count(*) into n from public.matches where id = v_match and status = 'over'
     and room_code = 'ABC234';
  if n <> 1 then
    raise exception
      'FAIL (CHECK 16): the original ABC234 match is not present and over, so reissuing the code proves nothing';
  end if;
  if v_reused = v_match then
    raise exception 'FAIL (CHECK 16): create_room returned the old match id instead of minting a new room';
  end if;
  select count(*) into n from public.matches where room_code = 'ABC234';
  if n <> 2 then
    raise exception 'FAIL (CHECK 16): % match row(s) carry the code ABC234, expected 2 (one over, one open)', n;
  end if;
  if (select status from public.matches where id = v_reused) <> 'open' then
    raise exception 'FAIL (CHECK 16): the reissued room is not open';
  end if;

  -- The other half of R110: uniqueness still holds *among rooms that are not over*. A
  -- reusable code must not become a code anyone can mint twice at once, and this is what
  -- an index that lost its WHERE clause — or lost UNIQUE — would fail.
  begin
    perform app.create_room(p1, 'ABC234', 'seed-3', '["core-001"]'::jsonb, 'core-1');
    raise exception
      'FAIL (CHECK 16): a second OPEN room took the code ABC234 — matches_room_code_open_key is not enforcing R110';
  exception
    when unique_violation then
      get stacked diagnostics refused_by = constraint_name;
      if refused_by is distinct from 'matches_room_code_open_key' then
        raise exception 'FAIL (CHECK 16): the duplicate open room was refused by "%", not matches_room_code_open_key',
          refused_by;
      end if;
      raise notice 'OK (CHECK 16): ABC234 reissued after its match ended, and matches_room_code_open_key still refuses a second open room';
    when others then
      if sqlerrm like 'FAIL%' then raise; end if;
      raise exception
        'FAIL (CHECK 16): the duplicate open room raised "%" (%), not unique_violation',
        sqlerrm, sqlstate;
  end;
end $$;

\echo '### tickets: one queued ticket per profile, atomic pair claim ###'
insert into public.tickets (profile_id, slot, rating, frozen_deck, catalog_version)
values ('11111111-1111-1111-1111-111111111111', 1, 1000, '["core-001"]'::jsonb, 'core-1')
returning id as ticket_a \gset
insert into public.tickets (profile_id, slot, rating, frozen_deck, catalog_version)
values ('22222222-2222-2222-2222-222222222222', 1, 1000, '["core-002"]'::jsonb, 'core-1')
returning id as ticket_b \gset
select set_config('mlc.ticket_a', :'ticket_a', false) as a,
       set_config('mlc.ticket_b', :'ticket_b', false) as b \gset

do $$
declare
  p1 constant uuid := '11111111-1111-1111-1111-111111111111';
  refused_by text;
  n bigint;
begin
  -- CHECK 17, part one. Vacuity guard: a second queued ticket can only be refused if a
  -- first one is actually sitting there queued.
  select count(*) into n from public.tickets where profile_id = p1 and status = 'queued';
  if n <> 1 then
    raise exception 'FAIL (CHECK 17): profile 1 holds % queued ticket(s), expected the 1 just inserted', n;
  end if;

  begin
    insert into public.tickets (profile_id, slot, rating, frozen_deck, catalog_version)
    values (p1, 2, 1000, '["core-002"]'::jsonb, 'core-1');
    raise exception 'FAIL (CHECK 17): a second queued ticket was accepted (SPEC §9.5: not already queued)';
  exception
    when unique_violation then
      get stacked diagnostics refused_by = constraint_name;
      if refused_by is distinct from 'tickets_profile_queued_key' then
        raise exception
          'FAIL (CHECK 17): the second queued ticket was refused by "%", not tickets_profile_queued_key',
          refused_by;
      end if;
      raise notice 'OK (CHECK 17): one queued ticket per profile, enforced by %', refused_by;
    when others then
      if sqlerrm like 'FAIL%' then raise; end if;
      raise exception 'FAIL (CHECK 17): the second queued ticket raised "%" (%), not unique_violation',
        sqlerrm, sqlstate;
  end;
end $$;

select app.start_match('11111111-1111-1111-1111-111111111111',
                       '22222222-2222-2222-2222-222222222222',
                       '["core-001"]'::jsonb, '["core-002"]'::jsonb,
                       'seed-queue-1', 'core-1') as queue_match \gset
select set_config('mlc.queue_match', :'queue_match', false) as stashed \gset
select :'queue_match'::uuid as queue_match;
do $$
declare
  v_queue constant uuid := current_setting('mlc.queue_match')::uuid;
  v_ticket_a constant uuid := current_setting('mlc.ticket_a')::uuid;
  v_ticket_b constant uuid := current_setting('mlc.ticket_b')::uuid;
  m record;
  n bigint;
begin
  -- The queue path creates a match that is live from the start (both players known).
  select * into m from public.matches where id = v_queue;
  if not found or m.status <> 'live' or m.room_code is not null or m.started_at is null then
    raise exception 'FAIL (CHECK 17): start_match produced status=% room_code=% started_at=%',
      m.status, m.room_code, m.started_at;
  end if;
  -- Vacuity guard for the claim below: both tickets must still be queued, or the first
  -- claim returning true and the second false says nothing about who won.
  select count(*) into n from public.tickets
   where id in (v_ticket_a, v_ticket_b) and status = 'queued';
  if n <> 2 then
    raise exception 'FAIL (CHECK 17): % of the 2 tickets are still queued before the first claim', n;
  end if;
end $$;
select app.claim_ticket_pair(:'ticket_a', :'ticket_b', :'queue_match') as first_claim \gset
select :'first_claim'::boolean as first_claim;
\echo '-- a second matcher must not be able to claim the same pair'
select app.claim_ticket_pair(:'ticket_a', :'ticket_b', :'queue_match') as second_claim \gset
select :'second_claim'::boolean as second_claim;
select set_config('mlc.first_claim', :'first_claim', false) as a,
       set_config('mlc.second_claim', :'second_claim', false) as b \gset
do $$
declare
  v_queue constant uuid := current_setting('mlc.queue_match')::uuid;
  v_ticket_a constant uuid := current_setting('mlc.ticket_a')::uuid;
  v_ticket_b constant uuid := current_setting('mlc.ticket_b')::uuid;
  first_claim  boolean := nullif(current_setting('mlc.first_claim',  true), '')::boolean;
  second_claim boolean := nullif(current_setting('mlc.second_claim', true), '')::boolean;
  n bigint;
begin
  -- CHECK 17, part two. SPEC §9.5 / ARCHITECTURE §6: "Claim both tickets in one atomic
  -- statement, or two matchers pair the same player into two matches."
  if first_claim is distinct from true then
    raise exception 'FAIL (CHECK 17): the first matcher got % from claim_ticket_pair, expected true', first_claim;
  end if;
  if second_claim is distinct from false then
    raise exception
      'FAIL (CHECK 17): the second matcher got % for a pair that was already claimed — two matchers can pair the same players twice',
      second_claim;
  end if;
  select count(*) into n from public.tickets
   where id in (v_ticket_a, v_ticket_b) and status = 'claimed'
     and match_id = v_queue and claimed_at is not null;
  if n <> 2 then
    raise exception
      'FAIL (CHECK 17): % of the 2 tickets are claimed against this match — the claim returned true without doing the work',
      n;
  end if;
end $$;

\echo '### reaper: a live match past its ceiling becomes a draw ###'
update public.matches set ceiling_at = now() - interval '1 minute'
 where id = :'queue_match';
do $$
declare
  v_queue constant uuid := current_setting('mlc.queue_match')::uuid;
  n bigint;
begin
  -- Vacuity guards for CHECK 18, captured before the sweep: exactly one match is past its
  -- ceiling, it is live, and it has no result yet. And a control that must survive the
  -- sweep — the open ABC234 room from CHECK 16, whose ceiling is the infinity placeholder.
  select count(*) into n from public.matches where status = 'live' and ceiling_at < now();
  if n <> 1 then
    raise exception 'FAIL (CHECK 18): % live match(es) are past the ceiling before the sweep, expected 1', n;
  end if;
  select count(*) into n from public.results where match_id = v_queue;
  if n <> 0 then
    raise exception 'FAIL (CHECK 18): the queue match already has a result before the reaper runs';
  end if;
  select count(*) into n from public.matches where status = 'open';
  if n <> 1 then
    raise exception
      'FAIL (CHECK 18): % open room(s) exist, expected the 1 that must survive the sweep untouched', n;
  end if;
end $$;
-- Same reason as CHECK 16: run the sweep where a refusal can be named.
do $$
declare
  v_reaped int;
begin
  begin
    v_reaped := app.reap_stale_matches();
  exception when others then
    raise exception 'FAIL (CHECK 18): reap_stale_matches() raised "%" (%) instead of sweeping',
      sqlerrm, sqlstate;
  end;
  perform set_config('mlc.reaped', v_reaped::text, false);
end $$;
select current_setting('mlc.reaped')::int as reaped;
select reason, winner_profile_id is null as is_draw from public.results
 where match_id = :'queue_match';
select id, current_match_id is null as cleared from public.profiles order by id;
do $$
declare
  v_queue constant uuid := current_setting('mlc.queue_match')::uuid;
  reaped int := coalesce(nullif(current_setting('mlc.reaped', true), ''), '-1')::int;
  r record;
  m record;
  n bigint;
begin
  if reaped <> 1 then
    raise exception 'FAIL (CHECK 18): reap_stale_matches() returned %, expected 1', reaped;
  end if;
  select * into r from public.results where match_id = v_queue;
  if not found then
    raise exception
      'FAIL (CHECK 18): the stale match has no result row — SPEC §9.5 says a reaper resolves anything past the ceiling';
  end if;
  if r.reason <> 'match-ceiling' or r.winner_profile_id is not null then
    raise exception 'FAIL (CHECK 18): the ceiling result reads reason=% winner=%, expected match-ceiling and a draw',
      r.reason, r.winner_profile_id;
  end if;
  select status, ended_at into m from public.matches where id = v_queue;
  if m.status <> 'over' or m.ended_at is null then
    raise exception 'FAIL (CHECK 18): the reaped match is status=% ended_at=%', m.status, m.ended_at;
  end if;
  select count(*) into n from public.profiles where current_match_id is not null;
  if n <> 0 then
    raise exception
      'FAIL (CHECK 18): % player(s) are still stuck in the reaped match — ARCHITECTURE §6.2s recurring bug', n;
  end if;

  -- Discrimination: the sweep is (status = live and ceiling_at < now()), not "end
  -- everything". The open room minted in CHECK 16 must be exactly where it was.
  select count(*) into n from public.matches where status = 'open' and room_code = 'ABC234';
  if n <> 1 then
    raise exception 'FAIL (CHECK 18): the reaper also closed the open room — it is not filtering on status = live';
  end if;
  -- And a second sweep finds nothing, since nothing live is past its ceiling any more.
  if app.reap_stale_matches() <> 0 then
    raise exception 'FAIL (CHECK 18): a second sweep reaped a match again';
  end if;
end $$;

-- ============================================================================
-- Evidence for the SPEC §11 rulings this schema implements.
--
-- A row is proved here by a `### Rnnn: ... ###` \echo heading and the assertions
-- under it. That heading form is the signal; a bare mention in prose is not.
--
-- NOT PROVED HERE, and deliberately so: R107 (the constant-time response
-- floor), R108 (sweeper and reaper cadence) and R109 (action-flooding limits)
-- are `apps/server/src/config.ts` values with no database behaviour to assert.
-- They are proved at the server level by BUILD M6-T1 (the 5 ms timing test),
-- M7-T1 and M7-T3. Those three ids appear in this comment as exclusions, never
-- as headings, so nothing below claims them.
-- ============================================================================

\echo '### R104: the room-code alphabet excludes 0, 1, I and O ###'
do $$
declare
  p1 constant uuid := '11111111-1111-1111-1111-111111111111';
  bad text;
  refused_by text;
begin
  -- CHECK 19. Vacuity guard first: a constraint that refuses every code would "prove"
  -- R104 by refusing the whole alphabet. ZZZ999 is drawn from the 32 symbols R104 keeps,
  -- so it must be accepted; the room it creates is rolled back with this subtransaction.
  begin
    perform app.create_room(p1, 'ZZZ999', 'seed-r104-ok', '["core-001"]'::jsonb, 'core-1');
    raise exception 'r104-control-rollback';
  exception when others then
    if sqlerrm <> 'r104-control-rollback' then
      raise exception
        'FAIL (CHECK 19): the legal room code ZZZ999 was refused with "%" (%) — the check refuses everything, so refusing 0/1/I/O proves nothing',
        sqlerrm, sqlstate;
    end if;
  end;

  foreach bad in array array['ABC23I', 'ABC23O', 'ABC230', 'ABC231', 'abc234', 'ABC23']
  loop
    begin
      perform app.create_room(p1, bad, 'seed-r104', '["core-001"]'::jsonb, 'core-1');
      raise exception 'FAIL (CHECK 19): room code % was accepted', bad;
    exception
      when check_violation then
        get stacked diagnostics refused_by = constraint_name;
        if refused_by is distinct from 'matches_room_code_format_check' then
          raise exception 'FAIL (CHECK 19): room code % was refused by "%", not matches_room_code_format_check',
            bad, refused_by;
        end if;
        raise notice 'OK (CHECK 19): % refused by %', bad, refused_by;
      when others then
        if sqlerrm like 'FAIL%' then raise; end if;
        raise exception
          'FAIL (CHECK 19): room code % raised "%" (%), not check_violation — the alphabet check is not what refused it',
          bad, sqlerrm, sqlstate;
    end;
  end loop;
end $$;

\echo '### R111: the launch grant is idempotent ###'
do $$
begin
  perform set_config('mlc.r111_collection',
    (select count(*) from public.collection
      where profile_id = '11111111-1111-1111-1111-111111111111')::text, false);
  perform set_config('mlc.r111_quantity',
    (select coalesce(sum(quantity), 0) from public.collection
      where profile_id = '11111111-1111-1111-1111-111111111111')::text, false);
  perform set_config('mlc.r111_grants',
    (select count(*) from public.collection_grants
      where profile_id = '11111111-1111-1111-1111-111111111111' and reason = 'launch')::text, false);
end $$;
select app.grant_launch_collection('11111111-1111-1111-1111-111111111111');
\echo '-- quantity must still be 1 per card, and no second launch grant row'
select count(*) as owned_cards, min(quantity) as min_quantity, max(quantity) as max_quantity
  from public.collection where profile_id = '11111111-1111-1111-1111-111111111111';
select count(*) as launch_grant_rows from public.collection_grants
 where profile_id = '11111111-1111-1111-1111-111111111111' and reason = 'launch';
\echo '-- and the token card is still not owned'
select count(*) as token_rows from public.collection c join public.cards k on k.id = c.card_id
 where c.profile_id = '11111111-1111-1111-1111-111111111111' and k.token;
do $$
declare
  p1 constant uuid := '11111111-1111-1111-1111-111111111111';
  was_collection bigint := coalesce(nullif(current_setting('mlc.r111_collection', true), ''), '-1')::bigint;
  was_quantity   bigint := coalesce(nullif(current_setting('mlc.r111_quantity',   true), ''), '-1')::bigint;
  was_grants     bigint := coalesce(nullif(current_setting('mlc.r111_grants',     true), ''), '-1')::bigint;
  now_collection bigint;
  now_quantity   bigint;
  now_grants     bigint;
  catalog        bigint;
  n              bigint;
begin
  -- CHECK 20. Vacuity guard: "nothing changed" is free if there was nothing there. The
  -- first grant (CHECK 2, and 01 CHECK 10 before it) must already have landed.
  if was_collection < 1 or was_grants < 1 then
    raise exception
      'FAIL (CHECK 20): profile 1 held % collection row(s) and % launch grant(s) before the repeat call — there was nothing for a second grant to duplicate',
      was_collection, was_grants;
  end if;

  select count(*), coalesce(sum(quantity), 0) into now_collection, now_quantity
    from public.collection where profile_id = p1;
  select count(*) into now_grants from public.collection_grants
   where profile_id = p1 and reason = 'launch';

  if now_collection <> was_collection or now_quantity <> was_quantity then
    raise exception
      'FAIL (CHECK 20): the collection went from % rows / % copies to % rows / % copies — the second launch grant was not a no-op',
      was_collection, was_quantity, now_collection, now_quantity;
  end if;
  if now_grants <> was_grants then
    raise exception 'FAIL (CHECK 20): launch grant rows went from % to % — the ledger recorded a second launch grant',
      was_grants, now_grants;
  end if;
  if now_quantity <> now_collection then
    raise exception 'FAIL (CHECK 20): % copies over % owned cards — the launch grant is not one copy per card',
      now_quantity, now_collection;
  end if;

  -- SPEC §9.1 "Everyone owns every card at launch", minus the Tokens of loadout rule L3.
  select count(*) into catalog from public.cards
   where token = false and catalog_version = 'core-1';
  if now_collection <> catalog then
    raise exception 'FAIL (CHECK 20): profile 1 owns % of the % non-Token cards in the catalog',
      now_collection, catalog;
  end if;
  select count(*) into n from public.collection c
    join public.cards k on k.id = c.card_id
   where c.profile_id = p1 and k.token;
  if n <> 0 then
    raise exception 'FAIL (CHECK 20): the launch grant handed over % Token card(s) (loadout rule L3)', n;
  end if;
end $$;

\echo '### R112: a reaper-resolved ceiling draw records turns 0 and moves no rating ###'
select r.turns,
       r.p1_rating_before = r.p1_rating_after as p1_rating_unchanged,
       r.p2_rating_before = r.p2_rating_after as p2_rating_unchanged
  from public.results r where r.match_id = :'queue_match';
do $$
declare
  v_queue constant uuid := current_setting('mlc.queue_match')::uuid;
  v_match     constant uuid := current_setting('mlc.match_id')::uuid;
  r record;
  h record;
begin
  -- CHECK 21. Vacuity guard: with no result row, "turns is 0 and no rating moved" is what
  -- an empty answer looks like — which is exactly how a reaper replaced by `select 0`
  -- used to pass here.
  select * into r from public.results where match_id = v_queue;
  if not found then
    raise exception
      'FAIL (CHECK 21): the reaper wrote no result row for the stale match, so there is nothing to read turns or ratings from';
  end if;
  if r.reason <> 'match-ceiling' then
    raise exception 'FAIL (CHECK 21): the row read here has reason=%, not the reapers match-ceiling', r.reason;
  end if;
  if r.turns <> 0 then
    raise exception
      'FAIL (CHECK 21): the ceiling draw recorded % turns; the live turn counter lives only in the actor, so a reaper-resolved draw records 0',
      r.turns;
  end if;
  if r.p1_rating_before <> r.p1_rating_after or r.p2_rating_before <> r.p2_rating_after then
    raise exception 'FAIL (CHECK 21): the ceiling draw moved ratings %->% and %->%',
      r.p1_rating_before, r.p1_rating_after, r.p2_rating_before, r.p2_rating_after;
  end if;

  -- Discrimination: turns 0 and an unchanged rating are properties of the *reaper-resolved*
  -- draw, not of every result row. The hero-death result of CHECK 14 is the control.
  select * into h from public.results where match_id = v_match;
  if not found then
    raise exception 'FAIL (CHECK 21): the hero-death result is missing, so there is no control to compare against';
  end if;
  if h.turns = 0 or h.p1_rating_before = h.p1_rating_after then
    raise exception
      'FAIL (CHECK 21): the hero-death control also reads turns=% and an unmoved rating — every result looks like a ceiling draw',
      h.turns;
  end if;
end $$;

\echo '### R106: the circuit breaker refuses redemption while it is open ###'
-- A third account and its own unspent code: `hash-good` had max_uses 2 and both
-- profiles above consumed them, so reusing it here would return the exhausted
-- `invalid_code` and prove nothing about the breaker.
insert into auth.users (id, email, email_confirmed_at)
values ('33333333-3333-3333-3333-333333333333', 'p3@example.test', now());
insert into public.invite_codes (code_hash, label, max_uses) values ('hash-r106', 'r106', 1);

do $$
declare
  p3 constant uuid := '33333333-3333-3333-3333-333333333333';
  v_rows int;
  v_now  text;
begin
  -- CHECK 22. Vacuity guards, all four of them, before anything is switched off:
  -- the account is redeemable, the code is unspent, the breaker is currently CLOSED, and
  -- — the one that matters most — there is a switch to open at all. Deleting
  -- app.settings.redemption_enabled used to leave this whole section green while it
  -- printed the opposite of every comment under it.
  if (select status from public.profiles where id = p3) is distinct from 'pending' then
    raise exception 'FAIL (CHECK 22): profile 3 is not pending, so its redemption cannot show the breaker';
  end if;
  if (select uses from public.invite_codes where code_hash = 'hash-r106') is distinct from 0 then
    raise exception 'FAIL (CHECK 22): hash-r106 is not an unspent code, so a refusal could be invalid_code instead';
  end if;
  v_now := app.setting('redemption_enabled') #>> '{}';
  if v_now is distinct from 'true' then
    raise exception
      'FAIL (CHECK 22): app.settings.redemption_enabled reads % before the test — the breaker is not closed to begin with',
      coalesce(v_now, '(missing)');
  end if;

  update app.settings set value = 'false'::jsonb where key = 'redemption_enabled';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception
      'FAIL (CHECK 22): opening the breaker updated % app.settings row(s) — R106s circuit breaker has no switch to throw',
      v_rows;
  end if;
  if (app.setting('redemption_enabled') #>> '{}') is distinct from 'false' then
    raise exception 'FAIL (CHECK 22): the breaker did not stay open after being set to false';
  end if;
end $$;
select app.redeem_invite_code('33333333-3333-3333-3333-333333333333', 'hash-r106', 'ip-c')
       as breaker_open \gset
select :'breaker_open' as breaker_open;
select set_config('mlc.breaker_open', :'breaker_open', false) as stashed \gset
\echo '-- the attempt was still logged, so an open breaker is not a blind spot'
select count(*) as logged_attempts from public.code_attempts
 where profile_id = '33333333-3333-3333-3333-333333333333';
\echo '-- and the breaker only gated: the code was not consumed, the profile not activated'
select uses from public.invite_codes where code_hash = 'hash-r106';
select status from public.profiles where id = '33333333-3333-3333-3333-333333333333';
do $$
declare
  p3 constant uuid := '33333333-3333-3333-3333-333333333333';
  answered text := nullif(current_setting('mlc.breaker_open', true), '');
  n bigint;
begin
  if answered is distinct from 'circuit_open' then
    raise exception
      'FAIL (CHECK 22): redemption answered "%" with the breaker open, expected circuit_open (SPEC §9.4)',
      coalesce(answered, '(nothing)');
  end if;
  -- SPEC §9.4 step (4): "log the attempt either way" — an open breaker is not a blind spot.
  select count(*) into n from public.code_attempts where profile_id = p3;
  if n <> 1 then
    raise exception 'FAIL (CHECK 22): % attempt(s) logged for the refused redemption, expected 1', n;
  end if;
  if exists (select 1 from public.code_attempts where profile_id = p3 and succeeded) then
    raise exception 'FAIL (CHECK 22): a redemption refused by the breaker was logged as succeeded';
  end if;
  -- And the breaker only gated: nothing was spent, nothing was activated.
  if (select uses from public.invite_codes where code_hash = 'hash-r106') <> 0 then
    raise exception 'FAIL (CHECK 22): the gated redemption still consumed a use of hash-r106';
  end if;
  if (select status from public.profiles where id = p3) <> 'pending' then
    raise exception 'FAIL (CHECK 22): the gated redemption still activated profile 3';
  end if;
end $$;

do $$
declare
  v_rows int;
begin
  update app.settings set value = 'true'::jsonb where key = 'redemption_enabled';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'FAIL (CHECK 22): closing the breaker updated % app.settings row(s)', v_rows;
  end if;
  if (app.setting('redemption_enabled') #>> '{}') is distinct from 'true' then
    raise exception 'FAIL (CHECK 22): the breaker did not close again';
  end if;
end $$;
\echo '-- with the breaker closed again, the untouched code redeems'
select app.redeem_invite_code('33333333-3333-3333-3333-333333333333', 'hash-r106', 'ip-c')
       as breaker_closed \gset
select :'breaker_closed' as breaker_closed;
select set_config('mlc.breaker_closed', :'breaker_closed', false) as stashed \gset
select status from public.profiles where id = '33333333-3333-3333-3333-333333333333';
do $$
declare
  p3 constant uuid := '33333333-3333-3333-3333-333333333333';
  answered text := nullif(current_setting('mlc.breaker_closed', true), '');
  n bigint;
begin
  -- The closing half is what makes the opening half mean something: the same account and
  -- the same code, refused while the breaker was open and accepted once it closed, so
  -- `circuit_open` above was the breaker and not some property of this account or code.
  if answered is distinct from 'ok' then
    raise exception
      'FAIL (CHECK 22): with the breaker closed the same redemption answered "%", expected ok — the refusal above was not the breaker',
      coalesce(answered, '(nothing)');
  end if;
  if (select status from public.profiles where id = p3) <> 'active' then
    raise exception 'FAIL (CHECK 22): profile 3 is not active after a successful redemption';
  end if;
  if (select uses from public.invite_codes where code_hash = 'hash-r106') <> 1 then
    raise exception 'FAIL (CHECK 22): hash-r106 was not consumed exactly once';
  end if;
  select count(*) into n from public.code_attempts where profile_id = p3;
  if n <> 2 then
    raise exception 'FAIL (CHECK 22): % attempt(s) logged for profile 3, expected 2 (one gated, one successful)', n;
  end if;
  select count(*) into n from public.code_attempts where profile_id = p3 and succeeded;
  if n <> 1 then
    raise exception 'FAIL (CHECK 22): % of profile 3s attempts are marked succeeded, expected 1', n;
  end if;
end $$;

\echo '### ALL LIFECYCLE CHECKS RAN ###'
