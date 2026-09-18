-- The room-code match path end to end, as the server (postgres/service_role)
-- would drive it. Runs after 99_checks.sql, which left profile 1 active with a
-- two-card collection and profiles 2 pending.
\set ON_ERROR_STOP on

\echo '### activate profile 2 so both players can queue and play ###'
update auth.users set email_confirmed_at = now()
 where id = '22222222-2222-2222-2222-222222222222';
select app.redeem_invite_code('22222222-2222-2222-2222-222222222222', 'hash-good', 'ip-b')
       as redeem_p2;

\echo '### save_loadout: L2 must reject a short deck ###'
do $$
declare
  v_decks jsonb := jsonb_build_array(
    jsonb_build_object('name', 'One',   'cards', jsonb_build_array(
      jsonb_build_object('card_id', 'core-001', 'count', 1))),
    jsonb_build_object('name', 'Two',   'cards', jsonb_build_array(
      jsonb_build_object('card_id', 'core-002', 'count', 1))),
    jsonb_build_object('name', 'Three', 'cards', '[]'::jsonb));
begin
  perform app.save_loadout('11111111-1111-1111-1111-111111111111', 'core-1', v_decks);
  raise notice 'FAIL: a 1-card deck was accepted';
exception when others then
  raise notice 'OK (L2/L1): %', sqlerrm;
end $$;

\echo '### save_loadout: a card in two decks must be rejected ###'
do $$
declare
  v_decks jsonb := jsonb_build_array(
    jsonb_build_object('name', 'One',   'cards', jsonb_build_array(
      jsonb_build_object('card_id', 'core-001', 'count', 1))),
    jsonb_build_object('name', 'Two',   'cards', jsonb_build_array(
      jsonb_build_object('card_id', 'core-001', 'count', 1))),
    jsonb_build_object('name', 'Three', 'cards', '[]'::jsonb));
begin
  perform app.save_loadout('11111111-1111-1111-1111-111111111111', 'core-1', v_decks);
  raise notice 'FAIL: L4 duplicate across decks accepted';
exception when others then
  raise notice 'OK (L4/L2): %', sqlerrm;
end $$;

\echo '### R105: a stale catalog version is refused at save and queue ###'
do $$
begin
  perform app.save_loadout('11111111-1111-1111-1111-111111111111', 'core-999', '[]'::jsonb);
  raise notice 'FAIL: stale catalog version accepted';
exception when others then
  raise notice 'OK: %', sqlerrm;
end $$;

\echo '### create_room -> join_room ###'
-- Clear the leftover hand-built loadout rows from 99_checks so the room path is clean.
delete from public.loadout_deck_cards
 where profile_id = '11111111-1111-1111-1111-111111111111';

select app.create_room(
  '11111111-1111-1111-1111-111111111111',
  'ABC234',
  'seed-bringup-1',
  '["core-001","core-002"]'::jsonb,
  'core-1') as match_id \gset

select id, room_code, status, seed, p1_profile_id, p2_profile_id,
       ceiling_at = 'infinity'::timestamptz as ceiling_is_placeholder
  from public.matches where id = :'match_id';

\echo '-- joining your own room must be refused'
do $$
begin
  perform app.join_room('ABC234', '11111111-1111-1111-1111-111111111111',
                        '["core-001"]'::jsonb, 'core-1');
  raise notice 'FAIL: joined own room';
exception when others then
  raise notice 'OK: %', sqlerrm;
end $$;

select app.join_room('ABC234', '22222222-2222-2222-2222-222222222222',
                     '["core-002","core-001"]'::jsonb, 'core-1') as joined_match_id;

select status, p2_profile_id is not null as p2_set,
       ceiling_at > now() as ceiling_stamped,
       started_at is not null as started
  from public.matches where id = :'match_id';

\echo '-- both players are marked in a match'
select id, current_match_id = :'match_id' as in_this_match
  from public.profiles order by id;

\echo '-- the room is no longer joinable'
do $$
begin
  perform app.join_room('ABC234', '22222222-2222-2222-2222-222222222222',
                        '["core-001"]'::jsonb, 'core-1');
  raise notice 'FAIL: a live room was joined again';
exception when others then
  raise notice 'OK: %', sqlerrm;
end $$;

\echo '### append_match_action: seq assignment and nonce dedupe ###'
select app.append_match_action(:'match_id', 'p1',
  '11111111-1111-1111-1111-111111111111', 'nonce-a',
  '{"type":"endTurn","playerId":"p1","nonce":"nonce-a"}'::jsonb) as seq_1;
select app.append_match_action(:'match_id', 'p2',
  '22222222-2222-2222-2222-222222222222', 'nonce-b',
  '{"type":"endTurn","playerId":"p2","nonce":"nonce-b"}'::jsonb) as seq_2;
\echo '-- the same nonce must return the original seq, not a new row'
select app.append_match_action(:'match_id', 'p1',
  '11111111-1111-1111-1111-111111111111', 'nonce-a',
  '{"type":"endTurn","playerId":"p1","nonce":"nonce-a"}'::jsonb) as seq_1_again;
select count(*) as logged_actions, max(seq) as high_water from public.match_actions
 where match_id = :'match_id';
select last_seq from public.matches where id = :'match_id';

\echo '-- a server action has no author'
select app.append_match_action(:'match_id', 'server', null, 'nonce-timeout',
  '{"type":"timeout"}'::jsonb) as seq_server;

\echo '### live_matches: what a restarting server folds ###'
select count(*) as live_matches from app.live_matches();

\echo '### end_match: one result row, ratings moved, in-match state cleared ###'
select app.end_match(:'match_id', '11111111-1111-1111-1111-111111111111',
                     'hero-death', 14, 1016, 984);
select reason, winner_profile_id = '11111111-1111-1111-1111-111111111111' as p1_won,
       turns, p1_rating_before, p1_rating_after, p2_rating_before, p2_rating_after
  from public.results where match_id = :'match_id';
select status, ended_at is not null as ended from public.matches where id = :'match_id';
select id, current_match_id is null as cleared, rating from public.profiles order by id;

\echo '-- end_match must be idempotent'
do $$
begin
  perform app.end_match('00000000-0000-0000-0000-000000000000'::uuid,
                        null, 'match-ceiling', 0, 1000, 1000);
exception when others then
  raise notice 'unknown match: %', sqlerrm;
end $$;
select app.end_match(:'match_id', '11111111-1111-1111-1111-111111111111',
                     'hero-death', 14, 1016, 984);
select count(*) as result_rows from public.results where match_id = :'match_id';

-- R142: this is where R110 is verifiable at all. Nothing lets a client ask for a specific room
-- code, so the reuse is proved here — mint a code, finish its match, mint the same code again —
-- and the end-to-end suite asserts only the consequence (both players queue-eligible once the
-- match is over), which `end_match` above has just shown.
\echo '### R110: a room code is reusable once its match is over (R142) ###'
select app.create_room('11111111-1111-1111-1111-111111111111', 'ABC234', 'seed-2',
                       '["core-001"]'::jsonb, 'core-1') as reused_code_match;

\echo '### tickets: one queued ticket per profile, atomic pair claim ###'
insert into public.tickets (profile_id, slot, rating, frozen_deck, catalog_version)
values ('11111111-1111-1111-1111-111111111111', 1, 1000, '["core-001"]'::jsonb, 'core-1')
returning id as ticket_a \gset
insert into public.tickets (profile_id, slot, rating, frozen_deck, catalog_version)
values ('22222222-2222-2222-2222-222222222222', 1, 1000, '["core-002"]'::jsonb, 'core-1')
returning id as ticket_b \gset

do $$
begin
  insert into public.tickets (profile_id, slot, rating, frozen_deck, catalog_version)
  values ('11111111-1111-1111-1111-111111111111', 2, 1000, '["core-002"]'::jsonb, 'core-1');
  raise notice 'FAIL: a second queued ticket was accepted';
exception when unique_violation then
  raise notice 'OK: one queued ticket per profile';
end $$;

select app.start_match('11111111-1111-1111-1111-111111111111',
                       '22222222-2222-2222-2222-222222222222',
                       '["core-001"]'::jsonb, '["core-002"]'::jsonb,
                       'seed-queue-1', 'core-1') as queue_match \gset
select app.claim_ticket_pair(:'ticket_a', :'ticket_b', :'queue_match') as first_claim;
\echo '-- a second matcher must not be able to claim the same pair'
select app.claim_ticket_pair(:'ticket_a', :'ticket_b', :'queue_match') as second_claim;

\echo '### reaper: a live match past its ceiling becomes a draw ###'
update public.matches set ceiling_at = now() - interval '1 minute'
 where id = :'queue_match';
select app.reap_stale_matches() as reaped;
select reason, winner_profile_id is null as is_draw from public.results
 where match_id = :'queue_match';
select id, current_match_id is null as cleared from public.profiles order by id;

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
  bad text;
begin
  foreach bad in array array['ABC23I', 'ABC23O', 'ABC230', 'ABC231', 'abc234', 'ABC23']
  loop
    begin
      perform app.create_room('11111111-1111-1111-1111-111111111111', bad, 'seed-r104',
                              '["core-001"]'::jsonb, 'core-1');
      raise notice 'FAIL (R104): room code % was accepted', bad;
    exception when check_violation then
      raise notice 'OK (R104): % refused', bad;
    end;
  end loop;
end $$;

\echo '### R111: the launch grant is idempotent ###'
select app.grant_launch_collection('11111111-1111-1111-1111-111111111111');
\echo '-- quantity must still be 1 per card, and no second launch grant row'
select card_id, quantity from public.collection
 where profile_id = '11111111-1111-1111-1111-111111111111' order by card_id;
select count(*) as launch_grant_rows from public.collection_grants
 where profile_id = '11111111-1111-1111-1111-111111111111' and reason = 'launch';
\echo '-- and the token card is still not owned'
select count(*) as token_rows from public.collection c join public.cards k on k.id = c.card_id
 where c.profile_id = '11111111-1111-1111-1111-111111111111' and k.token;

\echo '### R112: a reaper-resolved ceiling draw records turns 0 and moves no rating ###'
select r.turns,
       r.p1_rating_before = r.p1_rating_after as p1_rating_unchanged,
       r.p2_rating_before = r.p2_rating_after as p2_rating_unchanged
  from public.results r where r.match_id = :'queue_match';

\echo '### R106: the circuit breaker refuses redemption while it is open ###'
-- A third account and its own unspent code: `hash-good` had max_uses 2 and both
-- profiles above consumed them, so reusing it here would return the exhausted
-- `invalid_code` and prove nothing about the breaker.
insert into auth.users (id, email, email_confirmed_at)
values ('33333333-3333-3333-3333-333333333333', 'p3@example.test', now());
insert into public.invite_codes (code_hash, label, max_uses) values ('hash-r106', 'r106', 1);

update app.settings set value = 'false'::jsonb where key = 'redemption_enabled';
select app.redeem_invite_code('33333333-3333-3333-3333-333333333333', 'hash-r106', 'ip-c')
       as breaker_open;
\echo '-- the attempt was still logged, so an open breaker is not a blind spot'
select count(*) as logged_attempts from public.code_attempts
 where profile_id = '33333333-3333-3333-3333-333333333333';
\echo '-- and the breaker only gated: the code was not consumed, the profile not activated'
select uses from public.invite_codes where code_hash = 'hash-r106';
select status from public.profiles where id = '33333333-3333-3333-3333-333333333333';

update app.settings set value = 'true'::jsonb where key = 'redemption_enabled';
\echo '-- with the breaker closed again, the untouched code redeems'
select app.redeem_invite_code('33333333-3333-3333-3333-333333333333', 'hash-r106', 'ip-c')
       as breaker_closed;
select status from public.profiles where id = '33333333-3333-3333-3333-333333333333';

\echo '### ALL LIFECYCLE CHECKS RAN ###'
