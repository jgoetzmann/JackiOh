-- ============================================================================
-- Migration 0019: the ranked ladder -- seasons, ranks, bot ratings, rated games
-- ============================================================================
-- Serves SPEC.md §9.12 and R603-R612: the hidden Glicko-2 rating every player
-- climbs with, the Grape tiers they are shown, the numbered Jlorious
-- leaderboard, the seasons that reset it all, and the record every rated game
-- leaves.
--
-- What this file does:
--
--   1. Gives profiles the whole Glicko triple. `profiles.rating` was the Elo
--      int R79 used to describe; Glicko-2 ratings are fractional, so the
--      column widens to double precision, joined by `rating_deviation` and
--      `rating_volatility` defaulting to a new player's values (R603).
--      `tickets.rating` and `results`' four before/after columns take the same
--      widening -- what they hold is that rating.
--   2. Marks which games rate (R604): `matches.ranked` and `series.ranked`.
--      A match the queue paired, and a series the queue paired, is ranked;
--      a room challenge is not. The server writes the flag when it creates
--      the row; the default keeps the SQL-created shells unranked.
--   3. Recreates app.end_match on the widened rating: its p_*_rating_after
--      arguments and before-rating locals follow the columns to double
--      precision, so the SQL-only path cannot truncate a Glicko rating to an
--      integer. app.reap_stale_matches (0004) needs no change -- its
--      `(select rating ...)` arguments now arrive in the type the new
--      signature asks for.
--   4. Creates the four tables the ladder keeps:
--      * public.seasons      -- one row per season, named by the minor
--                               version (R609): 'v0.2' for every patch of v0.2.
--      * public.season_ranks -- one row per player per season (R605): the
--                               tally, the ladder position (null until the
--                               placements are played), the tier floor, the
--                               win streak and the season's peaks (R607).
--      * public.bot_ratings  -- each AI bot's own Glicko-2 rating (R610). A
--                               bot has no ladder rank and no leaderboard
--                               place, so it never reaches season_ranks.
--      * public.rated_games  -- one row per rated game (R611): a ranked
--                               match's id, or a ranked series' rated once
--                               when it ends (R262). Both sides' pilots,
--                               hidden ratings and visible ranks before and
--                               after.
--   5. Carves the hidden rating out of what an authenticated client can read.
--      R612: "No read carries the hidden rating, deviation or volatility --
--      not even to its owner." 0001 granted `authenticated` SELECT on all of
--      public.profiles, which until now covered the old int `rating` too, and
--      0004 granted it on all of public.tickets and public.results, whose
--      rating columns now hold the hidden Glicko rating (tickets.rating is the
--      queueing player's own; a results row carries BOTH players' before/after,
--      so its four columns are the opponent's hidden rating as well). A column
--      whitelist takes every one of them back. The four new tables get
--      no client grant at all: the client reads its rank through the API
--      (GET /api/ranked, /api/leaderboard), never the table.
--
-- Account deletion (SPEC §9.10, migration 0012): a deleted profile's season
-- ranks cascade away -- they are only its own -- while a rated game's side
-- SET NULLs its profile_id, so the other side's history stays whole. A bot
-- row survives: it is keyed on the bot id, not a profile.
--
-- Apply order: 0001 -> ... -> 0018 -> 0019 (this file). Only adds objects and
-- widens columns; the one DROP is app.end_match, whose signature change (the
-- int rating arguments to double precision) `create or replace` cannot make.
-- Safe to re-apply: create-if-not-exists, add-column-if-not-exists,
-- drop-function-if-exists, and plain revokes and grants.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. The Glicko triple, and every column that holds a rating, on doubles.
-- ----------------------------------------------------------------------------
alter table public.profiles
  alter column rating type double precision,
  add column if not exists rating_deviation  double precision not null default 350,
  add column if not exists rating_volatility double precision not null default 0.06;

comment on column public.profiles.rating is
  'SPEC §9.12 / R603: the hidden Glicko-2 rating. A new player starts at 1000; fractional once games move it. R612 keeps it off every client read -- the authenticated column revoke below is the table''s half of that.';

comment on column public.profiles.rating_deviation is
  'R603: Glicko-2 RD; a new player''s 350 is RATING_DEVIATION_START in apps/server/src/config.ts. R609''s soft reset widens it again.';

comment on column public.profiles.rating_volatility is
  'R603: Glicko-2 sigma; a new player''s 0.06 is RATING_VOLATILITY_START in apps/server/src/config.ts.';

alter table public.tickets
  alter column rating type double precision;

comment on column public.tickets.rating is
  'SPEC §9.5: the enqueueing player''s Glicko-2 rating (0019; Elo before that). The pairing scan reads it through tickets_pairing_scan_idx; the windows widen by time in queue.';

alter table public.results
  alter column p1_rating_before type double precision,
  alter column p1_rating_after  type double precision,
  alter column p2_rating_before type double precision,
  alter column p2_rating_after  type double precision;

comment on column public.results.p1_rating_before is
  $$Glicko-2 rating before/after (SPEC §9.12, R603; the int Elo pair it
  widens from was R79's). The update itself is computed in apps/server,
  not here -- app.end_match takes the *_after values as arguments so
  the constants are not duplicated in SQL.$$;

-- ----------------------------------------------------------------------------
-- 2. Which games rate (R604): the flag the queue writes and a room never gets.
-- ----------------------------------------------------------------------------
alter table public.matches
  add column if not exists ranked boolean not null default false;

comment on column public.matches.ranked is
  'R604: true for a match the queue paired (ranked): it moves the hidden rating and leaves a public.rated_games row. Room challenges and practice stay false. Written when the row turns live.';

alter table public.series
  add column if not exists ranked boolean not null default false;

comment on column public.series.ranked is
  'R604: true for a Conquest the queue paired. R262/R604: it moves the rating once, when the series ends, from the ratings at the time it ends.';

-- ----------------------------------------------------------------------------
-- 3. app.end_match on the widened rating.
-- ----------------------------------------------------------------------------
-- The same function as 0004's, verbatim except for the two types that follow
-- the widened columns: the p_*_rating_after arguments and the
-- v_*_rating_before locals move to double precision. A signature change
-- cannot be `create or replace`d, so the old one is dropped first. Its
-- remaining callers are 0004's app.reap_stale_matches and the e2e onlineReset
-- task, whose `(select rating ...)` arguments now arrive in the type this
-- signature asks for; the server's own ending is results.ts's
-- one-transaction write set and never calls this function (db/store.ts's
-- matches.finish comment).
drop function if exists app.end_match(uuid, uuid, text, int, int, int);

create or replace function app.end_match(
  p_match_id        uuid,
  p_winner          uuid,
  p_reason          text,
  p_turns           int,
  p_p1_rating_after double precision,
  p_p2_rating_after double precision
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_match     public.matches%rowtype;
  v_p1_before double precision;
  v_p2_before double precision;
begin
  select * into v_match from public.matches where id = p_match_id for update;

  if not found then
    raise exception 'app.end_match: match % not found', p_match_id;
  end if;

  -- Idempotent on a second call for the same match: SPEC §9.5's reaper
  -- and a client-driven ending could both race to end the same match; a
  -- second caller is a no-op here rather than a duplicate results row or
  -- a double rating update.
  if v_match.status = 'over' then
    return;
  end if;

  select rating into v_p1_before from public.profiles where id = v_match.p1_profile_id;
  select rating into v_p2_before from public.profiles where id = v_match.p2_profile_id;

  update public.matches
  set status = 'over', ended_at = now()
  where id = p_match_id;

  -- SPEC §2.5/§9.5: "Every ending records a result and clears both
  -- players' in-match state." One results row; before/after ratings are
  -- taken as arguments -- see the results.p1_rating_before column
  -- comment for why the Glicko update itself is not duplicated here.
  insert into public.results (
    match_id, p1_profile_id, p2_profile_id, winner_profile_id, reason, turns,
    p1_rating_before, p1_rating_after, p2_rating_before, p2_rating_after, ended_at
  ) values (
    p_match_id, v_match.p1_profile_id, v_match.p2_profile_id, p_winner, p_reason, p_turns,
    v_p1_before, p_p1_rating_after, v_p2_before, p_p2_rating_after, now()
  )
  on conflict (match_id) do nothing;

  update public.profiles
  set rating = p_p1_rating_after, current_match_id = null
  where id = v_match.p1_profile_id;

  update public.profiles
  set rating = p_p2_rating_after, current_match_id = null
  where id = v_match.p2_profile_id;

  -- Defensive cleanup: a profile can end up in a match a different way
  -- (e.g. it accepted a room challenge) while still holding a 'queued'
  -- ticket from an earlier enqueue. Clearing it here guards the
  -- tickets_profile_queued_key unique index so the profile can queue
  -- again immediately -- ARCHITECTURE-CCG.md §6.2's "recurring bug is a
  -- crashed actor leaving two players permanently unable to queue."
  update public.tickets
  set status = 'cancelled'
  where profile_id in (v_match.p1_profile_id, v_match.p2_profile_id)
    and status = 'queued';
end;
$$;

comment on function app.end_match(uuid, uuid, text, int, double precision, double precision) is
  $$SPEC §2.5/§9.5: flips the match to 'over', writes the one results row
  with before/after ratings, updates both profiles.rating, clears both
  current_match_id and any stray queued ticket. Idempotent on a repeat
  call for an already-'over' match. Takes *_rating_after as arguments --
  the Glicko-2 update (SPEC §9.12, R603) is computed in apps/server, so
  its constants are not duplicated in SQL. 0019 widened the rating
  arguments to doubles.$$;

revoke all on function app.end_match(uuid, uuid, text, int, double precision, double precision) from public;
grant execute on function app.end_match(uuid, uuid, text, int, double precision, double precision) to service_role;

-- ----------------------------------------------------------------------------
-- 4a. public.seasons (R609): one row per minor version. `id` is the name a
--     player sees ('v0.2'); `patch_version` records which build opened it.
-- ----------------------------------------------------------------------------
create table if not exists public.seasons (
  id            text        primary key,
  patch_version text        not null,
  started_at    timestamptz not null default now()
);

comment on table public.seasons is
  'R609: a season is named by the minor version. openSeason creates the row the first time a build''s season is seen -- server boot for its own build, src/db/season-start.ts ahead of a deploy.';

-- ----------------------------------------------------------------------------
-- 4b. public.season_ranks (R605, R607, R608): a player's visible state for one
--     season. `ladder` is the flat position (0..44 = five tiers of three
--     divisions of three pips, less one) the tier, division and pips decode
--     from -- null while the placements run; `floor` the lowest
--     ladder slot the season guarantees; `peak_ladder`/`peak_jlorious` the
--     season's best. `streak` is the consecutive-win count the streak rule
--     reads (a loss resets it to 0; a draw holds it).
-- ----------------------------------------------------------------------------
create table if not exists public.season_ranks (
  season_id     text        not null references public.seasons(id),
  profile_id    uuid        not null references public.profiles(id) on delete cascade,
  games         integer     not null,
  wins          integer     not null,
  losses        integer     not null,
  draws         integer     not null,
  ladder        integer,
  floor         integer     not null,
  streak        integer     not null,
  peak_ladder   integer,
  peak_jlorious integer,
  updated_at    timestamptz not null,
  primary key (season_id, profile_id)
);

comment on table public.season_ranks is
  'R605/R607: the visible rank, per player per season. What the client may see is the decoded tier+division+pips through the API -- the row itself, like the rating it shadows, is server-only (R612). ON DELETE CASCADE: a deleted account leaves nothing here.';

create index if not exists season_ranks_profile_idx
  on public.season_ranks (profile_id);

-- ----------------------------------------------------------------------------
-- 4c. public.bot_ratings (R610): a bot's own Glicko-2 rating, updated from its
--     games like a player's. Bots have no ladder rank and no leaderboard
--     place, and R609's season reset skips them.
-- ----------------------------------------------------------------------------
create table if not exists public.bot_ratings (
  bot_id     text             primary key,
  rating     double precision not null,
  deviation  double precision not null,
  volatility double precision not null,
  games      integer          not null,
  updated_at timestamptz      not null
);

comment on table public.bot_ratings is
  'R610: each AI bot keeps its own Glicko-2 rating for the games it plays. Excluded from season_ranks and the leaderboard, and never season-reset (R609).';

-- ----------------------------------------------------------------------------
-- 4d. public.rated_games (R611): the immutable record every rated game
--     leaves. One row per ranked match id or rated-once ranked series id;
--     the primary key alone is the "rate it once" guard R262 needs -- a
--     duplicate insert is the server's "already recorded". Each side carries
--     its pilot ('human'/'ai'), its profile or bot id, the hidden Glicko
--     before/after and the visible rank before/after as jsonb (the ladder's
--     snapshot shape is the code's, not the database's).
-- ----------------------------------------------------------------------------
create table if not exists public.rated_games (
  id              uuid        primary key,
  kind            text        not null check (kind in ('match', 'series')),
  season_id       text        not null references public.seasons(id),
  patch_version   text        not null,
  catalog_version text        not null,
  p1_profile_id   uuid        references public.profiles(id) on delete set null,
  p1_bot_id       text,
  p1_pilot        text        not null check (p1_pilot in ('human', 'ai')),
  p1_before       jsonb       not null,
  p1_after        jsonb       not null,
  p1_rank_before  jsonb,
  p1_rank_after   jsonb,
  p2_profile_id   uuid        references public.profiles(id) on delete set null,
  p2_bot_id       text,
  p2_pilot        text        not null check (p2_pilot in ('human', 'ai')),
  p2_before       jsonb       not null,
  p2_after        jsonb       not null,
  p2_rank_before  jsonb,
  p2_rank_after   jsonb,
  winner_side     smallint    check (winner_side in (0, 1)),
  reason          text        not null,
  ended_at        timestamptz not null,
  constraint rated_games_p1_side_check check (
    (p1_pilot = 'human' and p1_bot_id is null)
    or (p1_pilot = 'ai' and p1_profile_id is null and p1_bot_id is not null)),
  constraint rated_games_p2_side_check check (
    (p2_pilot = 'human' and p2_bot_id is null)
    or (p2_pilot = 'ai' and p2_profile_id is null and p2_bot_id is not null)),
  constraint rated_games_reason_check check (
    (kind = 'match' and reason in ('hero-death', 'both-heroes-dead', 'concede',
      'draw-accepted', 'turn-cap', 'disconnect', 'match-ceiling'))
    -- 'abandoned' is a SeriesEnd too, but an abandoned series moves nothing
    -- (R604), so no rated game is ever recorded with it.
    or (kind = 'series' and reason in ('decided', 'exhausted', 'forfeit')))
);

comment on table public.rated_games is
  'R611: every rated game recorded with patch, catalog version, each side''s pilot, hidden rating before/after, visible rank before/after, result and time. ON DELETE SET NULL on the profile ids (§9.10): a deleted account''s seat empties; the other side''s record stays.';

create index if not exists rated_games_p1_profile_idx
  on public.rated_games (p1_profile_id);
create index if not exists rated_games_p2_profile_idx
  on public.rated_games (p2_profile_id);
create index if not exists rated_games_season_idx
  on public.rated_games (season_id);

-- ----------------------------------------------------------------------------
-- 5. Grants: the hidden rating is server-only (R612).
-- ----------------------------------------------------------------------------
-- 0001 granted `authenticated` SELECT on the whole public.profiles row so a
-- client could read its own; that grant silently covered the rating, and a
-- column-level revoke cannot carve a column out of a table-level grant
-- (Postgres grants a column when either grant reaches it). The only shape that
-- hides the triple is a column whitelist: drop the table grant and re-grant
-- exactly the columns a client may read -- everything the row holds that is
-- not the hidden rating.
revoke select on public.profiles from authenticated;
grant select (id, status, display_name, current_match_id,
              created_at, updated_at, activated_at)
  on public.profiles to authenticated;

-- 0004 gave `tickets` and `results` the same table-level grant (own ticket,
-- own results), and it silently covered `tickets.rating` and the four
-- `results.*_rating_*` columns once they came to hold the hidden rating
-- (parts 1 and 3). Same carve-out: a column whitelist that grants every
-- column a client legitimately reads and not one rating column — an own
-- ticket's rating is the caller's hidden rating, an own result's the
-- opponent's as well, and R612 bars both.
revoke select on public.tickets from authenticated;
grant select (id, profile_id, slot, mode, frozen_deck, frozen_trio,
              catalog_version, status, enqueued_at, claimed_at, match_id)
  on public.tickets to authenticated;

revoke select on public.results from authenticated;
grant select (match_id, p1_profile_id, p2_profile_id, winner_profile_id,
              reason, turns, ended_at)
  on public.results to authenticated;

-- The four ranked tables: no grant at all for anon/authenticated, matching
-- matches/match_actions. What a client may see arrives through the API --
-- its own rank at GET /api/ranked and the Jlorious projection at
-- GET /api/leaderboard -- never as a table row. service_role's BYPASSRLS
-- already covers the server's reads and writes (0002's convention).
alter table public.seasons      enable row level security;
alter table public.season_ranks enable row level security;
alter table public.bot_ratings  enable row level security;
alter table public.rated_games  enable row level security;

revoke all on public.seasons      from public, anon, authenticated;
revoke all on public.season_ranks from public, anon, authenticated;
revoke all on public.bot_ratings  from public, anon, authenticated;
revoke all on public.rated_games  from public, anon, authenticated;
