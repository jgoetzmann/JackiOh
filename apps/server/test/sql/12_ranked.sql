-- The ranked ladder's tables (migration 0019, SPEC §9.12, R603-R612), as the server's role drives
-- them: the season rows, the per-season rank rows, the bot ratings and the rated-game records.
-- Runs after 11_player_settings.sql; profiles 1, 2 and 3 are active by then (03 activated them).
\set ON_ERROR_STOP on

-- Same rules as 01-11 (see 03's header for why each one exists): a check FAILS LOUDLY with
-- `raise exception 'FAIL (Rnnn): ...'`, an expected refusal is matched on its constraint name, and
-- a check that could be trivially true carries a control that succeeds.
--
-- Each SPEC §11 row this file proves is named in a `### Rnnn: … ###` heading, which is how the
-- §11 index (packages/engine/test/rulings.test.ts) credits an SQL file. Everything here is
-- rolled back.

\echo '### R603: profiles carry the Glicko triple; every rating column is a double ###'
begin;
do $$
declare
  wrong text := '';
begin
  -- The hidden rating is fractional; an int column would silently round it (the Elo column did).
  if (select data_type from information_schema.columns
       where table_schema = 'public' and table_name = 'profiles' and column_name = 'rating')
     is distinct from 'double precision' then
    wrong := wrong || 'profiles.rating ';
  end if;
  if (select data_type from information_schema.columns
       where table_schema = 'public' and table_name = 'profiles' and column_name = 'rating_deviation')
     is distinct from 'double precision' then
    wrong := wrong || 'profiles.rating_deviation ';
  end if;
  if (select data_type from information_schema.columns
       where table_schema = 'public' and table_name = 'profiles' and column_name = 'rating_volatility')
     is distinct from 'double precision' then
    wrong := wrong || 'profiles.rating_volatility ';
  end if;
  if (select data_type from information_schema.columns
       where table_schema = 'public' and table_name = 'tickets' and column_name = 'rating')
     is distinct from 'double precision' then
    wrong := wrong || 'tickets.rating ';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'results'
                and column_name like 'p__rating_%' and data_type <> 'double precision') then
    wrong := wrong || 'results.*_rating_* ';
  end if;
  if wrong <> '' then
    raise exception 'FAIL (R603): not double precision: %', wrong;
  end if;

  -- A new profile's deviation and volatility are the config's (R603), no trigger needed.
  if (select rating_deviation from public.profiles where id = '11111111-1111-1111-1111-111111111111')
       is distinct from 350::float8
     or (select rating_volatility from public.profiles where id = '11111111-1111-1111-1111-111111111111')
       is distinct from 0.06::float8 then
    raise exception 'FAIL (R603): profile 1 does not carry the new-player deviation and volatility';
  end if;

  -- app.end_match's rating arguments followed the columns (the reaper passes (select rating …)).
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'app' and p.proname = 'end_match'
                    and pg_get_function_arguments(p.oid) like '%_rating_after double precision%') then
    raise exception 'FAIL (R603): app.end_match does not take double ratings — the reaper''s call cannot land';
  end if;

  raise notice 'OK (R603): the Glicko triple is on profiles; every rating column and end_match take doubles';
end $$;
rollback;

\echo '### R604: matches and series carry the ranked flag, defaulting unranked ###'
begin;
do $$
declare
  v_ranked boolean;
begin
  if (select data_type from information_schema.columns
       where table_schema = 'public' and table_name = 'matches' and column_name = 'ranked')
     is distinct from 'boolean'
     or (select data_type from information_schema.columns
       where table_schema = 'public' and table_name = 'series' and column_name = 'ranked')
     is distinct from 'boolean' then
    raise exception 'FAIL (R604): matches.ranked or series.ranked is missing';
  end if;

  -- The flag defaults unranked: the SQL-created shells (rooms, queue pairings) start unranked,
  -- and the server's own write is what sets it.
  insert into public.matches (id, status, seed, p1_profile_id, p2_profile_id, p1_deck, p2_deck,
                            catalog_version, started_at, ceiling_at)
    values ('aaaaaaaa-0000-4000-8000-000000000001', 'live', 'seed',
            '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
            '[]'::jsonb, '[]'::jsonb, 'core-1', now(), now() + interval '1 hour')
    returning ranked into v_ranked;
  if v_ranked is distinct from false then
    raise exception 'FAIL (R604): a match defaults ranked=%, expected false', v_ranked;
  end if;
  raise notice 'OK (R604): matches.ranked and series.ranked exist and default unranked';
end $$;
rollback;

\echo '### R609: a season row and the per-season rank key, and R610: the bots own table ###'
begin;
do $$
declare
  refused_by text;
begin
  insert into public.seasons (id, patch_version, started_at) values ('v0.1', 'v0.1.1', now());
  insert into public.season_ranks (season_id, profile_id, games, wins, losses, draws, ladder,
                                   floor, streak, peak_ladder, peak_jlorious, updated_at)
    values ('v0.1', '11111111-1111-1111-1111-111111111111', 5, 5, 0, 0, 40, 1, 5, 40, null, now());

  -- One row per player per season: the composite key, not either column alone.
  begin
    insert into public.season_ranks (season_id, profile_id, games, wins, losses, draws, ladder,
                                     floor, streak, peak_ladder, peak_jlorious, updated_at)
      values ('v0.1', '11111111-1111-1111-1111-111111111111', 6, 6, 0, 0, 41, 1, 6, 41, 3, now());
    raise exception 'FAIL (R609): a second season_ranks row for the same player and season held';
  exception
    when unique_violation then
      get stacked diagnostics refused_by = constraint_name;
      if refused_by is distinct from 'season_ranks_pkey' then
        raise exception 'FAIL (R609): the duplicate was refused by %, not season_ranks_pkey', refused_by;
      end if;
  end;
  -- …while the same player in another season is another row.
  insert into public.seasons (id, patch_version, started_at) values ('v0.2', 'v0.2.0', now());
  insert into public.season_ranks (season_id, profile_id, games, wins, losses, draws, ladder,
                                   floor, streak, peak_ladder, peak_jlorious, updated_at)
    values ('v0.2', '11111111-1111-1111-1111-111111111111', 0, 0, 0, 0, null, 0, 0, null, null, now());

  -- A rank row needs its season.
  begin
    insert into public.season_ranks (season_id, profile_id, games, wins, losses, draws, ladder,
                                     floor, streak, peak_ladder, peak_jlorious, updated_at)
      values ('v9.9', '22222222-2222-2222-2222-222222222222', 0, 0, 0, 0, null, 0, 0, null, null, now());
    raise exception 'FAIL (R609): a season_ranks row for a season that does not exist held';
  exception
    when foreign_key_violation then null;
  end;

  -- A bot's row stands alone (R610): one row per bot, rewritable, no profile and no rank.
  insert into public.bot_ratings (bot_id, rating, deviation, volatility, games, updated_at)
    values ('ai-easy', 1050.5, 300.25, 0.06, 3, now());
  begin
    insert into public.bot_ratings (bot_id, rating, deviation, volatility, games, updated_at)
      values ('ai-easy', 1000, 350, 0.06, 0, now());
    raise exception 'FAIL (R610): a second bot_ratings row for the same bot held';
  exception
    when unique_violation then
      get stacked diagnostics refused_by = constraint_name;
      if refused_by is distinct from 'bot_ratings_pkey' then
        raise exception 'FAIL (R610): the duplicate was refused by %, not bot_ratings_pkey', refused_by;
      end if;
  end;

  raise notice 'OK (R609, R610): one rank row per player per season, keyed on its season; one rating row per bot';
end $$;
rollback;

\echo '### R611: rated_games holds both sides whole, once per game ###'
begin;
do $$
declare
  refused_by text;
  v_row      record;
begin
  insert into public.seasons (id, patch_version, started_at) values ('v0.1', 'v0.1.1', now());

  -- A well-formed rated match, both sides human.
  insert into public.rated_games (id, kind, season_id, patch_version, catalog_version,
    p1_profile_id, p1_bot_id, p1_pilot, p1_before, p1_after, p1_rank_before, p1_rank_after,
    p2_profile_id, p2_bot_id, p2_pilot, p2_before, p2_after, p2_rank_before, p2_rank_after,
    winner_side, reason, ended_at)
    values ('aaaaaaaa-0000-4000-8000-0000000000aa', 'match', 'v0.1', 'v0.1.1', 'core-1',
      '11111111-1111-1111-1111-111111111111', null, 'human',
      '{"rating":1000,"deviation":350,"volatility":0.06}'::jsonb,
      '{"rating":1016,"deviation":340,"volatility":0.06}'::jsonb, null, '{"seasonId":"v0.1","tier":"rotten","division":3,"pips":2}'::jsonb,
      '22222222-2222-2222-2222-222222222222', null, 'human',
      '{"rating":1000,"deviation":350,"volatility":0.06}'::jsonb,
      '{"rating":984,"deviation":340,"volatility":0.06}'::jsonb, null, '{"seasonId":"v0.1","tier":"rotten","division":3,"pips":1}'::jsonb,
      0, 'hero-death', now());

  -- A bot side is a bot id and the ai pilot, no profile and no ranks.
  insert into public.rated_games (id, kind, season_id, patch_version, catalog_version,
    p1_profile_id, p1_bot_id, p1_pilot, p1_before, p1_after, p1_rank_before, p1_rank_after,
    p2_profile_id, p2_bot_id, p2_pilot, p2_before, p2_after, p2_rank_before, p2_rank_after,
    winner_side, reason, ended_at)
    values ('aaaaaaaa-0000-4000-8000-0000000000ab', 'match', 'v0.1', 'v0.1.1', 'core-1',
      '11111111-1111-1111-1111-111111111111', null, 'human',
      '{"rating":1016,"deviation":340,"volatility":0.06}'::jsonb,
      '{"rating":1030,"deviation":330,"volatility":0.06}'::jsonb, null, null,
      null, 'ai-easy', 'ai',
      '{"rating":1050,"deviation":300,"volatility":0.06}'::jsonb,
      '{"rating":1036,"deviation":295,"volatility":0.06}'::jsonb, null, null,
      0, 'concede', now());

  -- One row per game: the same id again is the rate-once guard (R262's is built on it).
  begin
    insert into public.rated_games (id, kind, season_id, patch_version, catalog_version,
      p1_profile_id, p1_bot_id, p1_pilot, p1_before, p1_after, p1_rank_before, p1_rank_after,
      p2_profile_id, p2_bot_id, p2_pilot, p2_before, p2_after, p2_rank_before, p2_rank_after,
      winner_side, reason, ended_at)
      values ('aaaaaaaa-0000-4000-8000-0000000000aa', 'match', 'v0.1', 'v0.1.1', 'core-1',
        '11111111-1111-1111-1111-111111111111', null, 'human',
        '{}'::jsonb, '{}'::jsonb, null, null,
        '22222222-2222-2222-2222-222222222222', null, 'human',
        '{}'::jsonb, '{}'::jsonb, null, null,
        null, 'concede', now());
    raise exception 'FAIL (R611): a second rated_games row for one match id held';
  exception
    when unique_violation then
      get stacked diagnostics refused_by = constraint_name;
      if refused_by is distinct from 'rated_games_pkey' then
        raise exception 'FAIL (R611): the duplicate was refused by %, not rated_games_pkey', refused_by;
      end if;
  end;

  -- The side shape: a human pilot holds no bot id; an ai pilot holds no profile id.
  begin
    insert into public.rated_games (id, kind, season_id, patch_version, catalog_version,
      p1_profile_id, p1_bot_id, p1_pilot, p1_before, p1_after, p1_rank_before, p1_rank_after,
      p2_profile_id, p2_bot_id, p2_pilot, p2_before, p2_after, p2_rank_before, p2_rank_after,
      winner_side, reason, ended_at)
      values ('aaaaaaaa-0000-4000-8000-0000000000ac', 'match', 'v0.1', 'v0.1.1', 'core-1',
        '11111111-1111-1111-1111-111111111111', 'ai-easy', 'human',
        '{}'::jsonb, '{}'::jsonb, null, null,
        '22222222-2222-2222-2222-222222222222', null, 'human',
        '{}'::jsonb, '{}'::jsonb, null, null,
        null, 'concede', now());
    raise exception 'FAIL (R611): a human side carrying a bot id held';
  exception
    when check_violation then
      get stacked diagnostics refused_by = constraint_name;
      if refused_by is distinct from 'rated_games_p1_side_check' then
        raise exception 'FAIL (R611): the bad side was refused by %, not rated_games_p1_side_check', refused_by;
      end if;
  end;

  -- A match-kind row takes only a GameOverReason; a series-kind row only a SeriesEnd.
  begin
    insert into public.rated_games (id, kind, season_id, patch_version, catalog_version,
      p1_profile_id, p1_bot_id, p1_pilot, p1_before, p1_after, p1_rank_before, p1_rank_after,
      p2_profile_id, p2_bot_id, p2_pilot, p2_before, p2_after, p2_rank_before, p2_rank_after,
      winner_side, reason, ended_at)
      values ('aaaaaaaa-0000-4000-8000-0000000000ad', 'match', 'v0.1', 'v0.1.1', 'core-1',
        '11111111-1111-1111-1111-111111111111', null, 'human',
        '{}'::jsonb, '{}'::jsonb, null, null,
        '22222222-2222-2222-2222-222222222222', null, 'human',
        '{}'::jsonb, '{}'::jsonb, null, null,
        null, 'forfeit', now());
    raise exception 'FAIL (R611): a match row carrying a series end held';
  exception
    when check_violation then
      get stacked diagnostics refused_by = constraint_name;
      if refused_by is distinct from 'rated_games_reason_check' then
        raise exception 'FAIL (R611): the bad reason was refused by %, not rated_games_reason_check', refused_by;
      end if;
  end;

  raise notice 'OK (R611): one row per game, both pilots, hidden ratings and visible ranks';
end $$;
rollback;

\echo '-- a deleted account leaves the record with its seat emptied (§9.10, rolled back)'
begin;
insert into auth.users (id, email, email_confirmed_at)
values ('88888888-8888-4888-8888-888888888888', 'gone@example.test', now());
insert into public.seasons (id, patch_version, started_at) values ('v0.1', 'v0.1.1', now());
insert into public.rated_games (id, kind, season_id, patch_version, catalog_version,
  p1_profile_id, p1_bot_id, p1_pilot, p1_before, p1_after, p1_rank_before, p1_rank_after,
  p2_profile_id, p2_bot_id, p2_pilot, p2_before, p2_after, p2_rank_before, p2_rank_after,
  winner_side, reason, ended_at)
  values ('aaaaaaaa-0000-4000-8000-0000000000ae', 'match', 'v0.1', 'v0.1.1', 'core-1',
    '11111111-1111-1111-1111-111111111111', null, 'human',
    '{"rating":1030,"deviation":330,"volatility":0.06}'::jsonb,
    '{"rating":1041,"deviation":325,"volatility":0.06}'::jsonb, null, null,
    '88888888-8888-4888-8888-888888888888', null, 'human',
    '{"rating":1000,"deviation":350,"volatility":0.06}'::jsonb,
    '{"rating":988,"deviation":345,"volatility":0.06}'::jsonb, null, null,
    0, 'hero-death', now());
do $$
declare
  v_row record;
begin
  select * into v_row from public.rated_games where id = 'aaaaaaaa-0000-4000-8000-0000000000ae';
  delete from public.profiles where id = '88888888-8888-4888-8888-888888888888';
  if (select p2_profile_id from public.rated_games where id = v_row.id) is not null
     or (select p1_profile_id from public.rated_games where id = v_row.id)
          is distinct from v_row.p1_profile_id
     or (select p2_after ->> 'rating' from public.rated_games where id = v_row.id) is null then
    raise exception 'FAIL (R611): deleting a side''s profile did not empty exactly that seat';
  end if;
  raise notice 'OK (R611): a deleted account''s seat is null while the record and the other side stay';
end $$;
rollback;

\echo '### R612: an authenticated client cannot select the hidden rating ###'
begin;
-- Fixtures as the migration role, before the authenticated switch: profile 1 has a
-- queued ticket and a finished result against profile 2 — the two rows whose own-side
-- columns used to carry the hidden rating to the client (and the opponent's on results).
insert into public.tickets (id, profile_id, slot, rating, frozen_deck, catalog_version, status)
  values ('bbbbbbbb-0000-4000-8000-000000000001',
          '11111111-1111-1111-1111-111111111111', 1, 1000.5, '[]'::jsonb, 'core-1', 'queued');
insert into public.matches (id, status, seed, p1_profile_id, p2_profile_id, p1_deck, p2_deck,
                            catalog_version, started_at, ceiling_at)
  values ('cccccccc-0000-4000-8000-000000000001', 'over', 'seed',
          '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
          '[]'::jsonb, '[]'::jsonb, 'core-1', now(), now());
insert into public.results (match_id, p1_profile_id, p2_profile_id, winner_profile_id, reason,
                            turns, p1_rating_before, p1_rating_after, p2_rating_before, p2_rating_after)
  values ('cccccccc-0000-4000-8000-000000000001',
          '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
          '11111111-1111-1111-1111-111111111111', 'concede', 12,
          1000.5, 1016.25, 1200.75, 1184.5);
set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
do $$
declare
  seen bigint;
  denied text;
begin
  if current_user <> 'authenticated' then
    raise exception 'FAIL (R612): running as %, not authenticated — SET LOCAL did not take', current_user;
  end if;

  -- Vacuity guard: the same row is still reachable by the columns a client may read, or the
  -- refusal below means the row itself is gone, not the rating.
  select count(*) into seen from public.profiles where id = '11111111-1111-1111-1111-111111111111';
  if seen <> 1 then
    raise exception 'FAIL (R612): profile 1''s own row did not come back, so the rating refusal below proves nothing';
  end if;

  begin
    perform rating from public.profiles where id = '11111111-1111-1111-1111-111111111111';
    raise exception 'FAIL (R612): authenticated read profiles.rating — R612 says no client read may carry the hidden rating';
  exception
    when insufficient_privilege then
      raise notice 'OK (R612): profiles.rating refused (insufficient_privilege, %)', sqlstate;
    when others then
      if sqlerrm like 'FAIL%' then raise; end if;
      raise exception 'FAIL (R612): profiles.rating raised "%" (%), not insufficient_privilege', sqlerrm, sqlstate;
  end;

  begin
    perform rating_deviation from public.profiles where id = '11111111-1111-1111-1111-111111111111';
    raise exception 'FAIL (R612): authenticated read profiles.rating_deviation';
  exception
    when insufficient_privilege then
      raise notice 'OK (R612): profiles.rating_deviation refused';
    when others then
      if sqlerrm like 'FAIL%' then raise; end if;
      raise exception 'FAIL (R612): profiles.rating_deviation raised "%" (%)', sqlerrm, sqlstate;
  end;

  begin
    perform rating_volatility from public.profiles where id = '11111111-1111-1111-1111-111111111111';
    raise exception 'FAIL (R612): authenticated read profiles.rating_volatility';
  exception
    when insufficient_privilege then
      raise notice 'OK (R612): profiles.rating_volatility refused';
    when others then
      if sqlerrm like 'FAIL%' then raise; end if;
      raise exception 'FAIL (R612): profiles.rating_volatility raised "%" (%)', sqlerrm, sqlstate;
  end;

  raise notice 'OK (R612): the whole hidden triple is refused to the client while its own row stays readable';

  -- Same carve-out on the two tables 0004 granted wholesale: an own ticket's rating and a
  -- results row's before/after ratings (the p2_* columns are the OPPONENT's hidden rating).
  -- Vacuity first: the row must still come back through an allowed column, or a rating
  -- refusal proves nothing.
  select count(*) into seen
    from public.tickets
   where id = 'bbbbbbbb-0000-4000-8000-000000000001' and status = 'queued' and match_id is null;
  if seen <> 1 then
    raise exception 'FAIL (R612): profile 1''s own ticket did not come back through the allowed columns';
  end if;

  begin
    perform rating from public.tickets where id = 'bbbbbbbb-0000-4000-8000-000000000001';
    raise exception 'FAIL (R612): authenticated read tickets.rating — a client''s own ticket leaks its hidden rating';
  exception
    when insufficient_privilege then
      raise notice 'OK (R612): tickets.rating refused (insufficient_privilege)';
    when others then
      if sqlerrm like 'FAIL%' then raise; end if;
      raise exception 'FAIL (R612): tickets.rating raised "%" (%), not insufficient_privilege', sqlerrm, sqlstate;
  end;

  select count(*) into seen
    from public.results
   where match_id = 'cccccccc-0000-4000-8000-000000000001' and reason = 'concede' and turns = 12;
  if seen <> 1 then
    raise exception 'FAIL (R612): profile 1''s own result did not come back through the allowed columns';
  end if;

  foreach denied in array array['p1_rating_before', 'p1_rating_after', 'p2_rating_before', 'p2_rating_after']
  loop
    begin
      execute format('select count(%I) from public.results where match_id = %L', denied, 'cccccccc-0000-4000-8000-000000000001')
        into seen;
      raise exception 'FAIL (R612): authenticated read results.% — a shared results row leaks the hidden rating', denied;
    exception
      when insufficient_privilege then
        raise notice 'OK (R612): results.% refused (insufficient_privilege)', denied;
      when others then
        if sqlerrm like 'FAIL%' then raise; end if;
        raise exception 'FAIL (R612): results.% raised "%" (%), not insufficient_privilege', denied, sqlerrm, sqlstate;
    end;
  end loop;

  raise notice 'OK (R612): tickets and results refuse every rating column while their own rows stay readable';
end $$;
rollback;

\echo '### ALL RANKED CHECKS RAN ###'
