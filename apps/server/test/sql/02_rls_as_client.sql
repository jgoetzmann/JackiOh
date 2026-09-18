-- The critical test: act as the `authenticated` role inside a transaction, so
-- SET LOCAL actually takes effect and RLS is really exercised.
-- Profile 1 is active with a collection; profile 2 exists and is pending.

\echo '### as authenticated = profile 1 ###'
begin;
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
rollback;

\echo '### as authenticated = profile 2 (owns nothing) ###'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
\echo '-- profiles: must be 1 (its own row, not profile 1s)'
select count(*) as profiles_visible from public.profiles;
\echo '-- collection: must be 0 (profile 1s rows must NOT be visible)'
select count(*) as collection_visible from public.collection;
\echo '-- loadout_deck_cards: must be 0'
select count(*) as deck_cards_visible from public.loadout_deck_cards;
rollback;

\echo '### tables the client must not reach at all ###'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
do $$
declare
  t text;
  n bigint;
begin
  for t in select unnest(array['invite_codes', 'code_attempts', 'matches', 'match_actions'])
  loop
    begin
      execute format('select count(*) from public.%I', t) into n;
      raise notice 'FAIL: % readable, % rows', t, n;
    exception when insufficient_privilege then
      raise notice 'OK: % refused (insufficient_privilege)', t;
    end;
  end loop;
end $$;
rollback;

\echo '### client write attempts must all fail ###'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
do $$
begin
  begin
    insert into public.collection (profile_id, card_id, quantity)
    values ('22222222-2222-2222-2222-222222222222', 'core-001', 99);
    raise notice 'FAIL: collection INSERT succeeded';
  exception when insufficient_privilege then raise notice 'OK: collection INSERT refused';
  end;
  begin
    update public.profiles set status = 'active'
     where id = '22222222-2222-2222-2222-222222222222';
    raise notice 'FAIL: profiles UPDATE succeeded';
  exception when insufficient_privilege then raise notice 'OK: profiles UPDATE refused';
  end;
  begin
    insert into public.loadout_deck_cards (profile_id, slot, card_id, count)
    values ('11111111-1111-1111-1111-111111111111', 3, 'core-002', 1);
    raise notice 'FAIL: loadout_deck_cards INSERT succeeded';
  exception when insufficient_privilege then
    raise notice 'OK: loadout_deck_cards INSERT refused';
  end;
  begin
    perform app.redeem_invite_code('22222222-2222-2222-2222-222222222222', 'x', 'y');
    raise notice 'FAIL: redeem_invite_code callable by a client';
  exception when insufficient_privilege then
    raise notice 'OK: app.redeem_invite_code refused';
  end;
  begin
    perform app.save_loadout('22222222-2222-2222-2222-222222222222', 'core-1', '[]'::jsonb);
    raise notice 'FAIL: save_loadout callable by a client';
  exception when insufficient_privilege then raise notice 'OK: app.save_loadout refused';
  end;
end $$;
rollback;
