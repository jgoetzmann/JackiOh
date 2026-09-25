-- ============================================================================
-- Migration 0009: The Best-of-3 series
-- ============================================================================
-- Serves SPEC.md §9.5 ("Best of 3") and SPEC §11 R259-R263, quoted:
--   R263: "A series is a database row, written only by compare-and-set on its
--   version, and a game's result, the series' record of it and, when the game
--   ends the series, the rating move commit in one transaction. The next
--   game's match id is reserved when its pick phase opens. ... A series that
--   ends before its first game releases the id it reserved."
--   R259: "a pick is hidden from the opponent until both have picked ...
--   Neither side is shown the other's deck names or lists, only which of their
--   decks have been played."
-- and SPEC §9.1/§9.8, which put the opponent's hidden choices outside the
-- trust boundary exactly as they put the opponent's hand there.
--
-- Apply order: 0001 (`public.profiles`) -> ... -> 0008 -> 0009 (this file).
-- This file only ADDS objects. Safe to re-apply.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- public.series -- one row per Best-of-3 series (R259-R263).
-- ----------------------------------------------------------------------------
-- The columns are what something queries or constrains: who is in it (a
-- profile is in at most one series that is not over, and the queue asks),
-- where it stands (the sweeper scans every series that is not over, R263),
-- the match its game in play is (a game's result finds its series by it),
-- its clock (R260) and its version (R263's compare-and-set). Everything the
-- series only ever reads back whole -- each side's frozen trio, wins and
-- pick, the record of its games, its seed base, why it ended and the ratings
-- it moved (R262) -- is `state`, one jsonb document the server writes and
-- reads as a unit through the Store port's `SeriesRow`.
create table if not exists public.series (
  id               uuid primary key,
  p1_profile_id    uuid not null references public.profiles(id),
  p2_profile_id    uuid not null references public.profiles(id),
  status           text not null,
  -- R263: "The next game's match id is reserved when its pick phase opens"
  -- -- for game 1 when the series is made, for games 2 and 3 when the game
  -- before them ends. The match row is written only when the game starts, so
  -- at every moment but play this id names a match that does NOT exist yet.
  -- That is why it has no foreign key into public.matches: one would refuse
  -- the reservation itself.
  next_match_id    uuid not null,
  pick_deadline_at timestamptz,
  version          int not null,
  catalog_version  text not null,
  winner           text,
  state            jsonb not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  ended_at         timestamptz,
  constraint series_status_check check (
    -- 'picking' -- both players choose the next game's deck (R259, R260);
    -- 'playing' -- the game next_match_id names is being played or started;
    -- 'over'    -- decided, played out, forfeited or abandoned (R261).
    status in ('picking', 'playing', 'over')
  ),
  constraint series_winner_check check (
    -- R261: a side, or 'draw' for equal wins after SERIES_MAX_GAMES; NULL
    -- until the series is over, and for an abandoned one (R260).
    winner is null or winner in ('p1', 'p2', 'draw')
  ),
  constraint series_players_differ_check check (p1_profile_id <> p2_profile_id),
  constraint series_version_check check (version >= 0),
  constraint series_state_is_object_check check (jsonb_typeof(state) = 'object')
);

comment on table public.series is
  $$SPEC §9.5 / R259-R263: one row per Best-of-3 series, written by
  compare-and-set on `version` (R263) -- the server's update is `where id = $1
  and version = <the version it read>`, so of two writers that read the same
  row exactly one lands its transition and the other re-reads. A game's
  result, this row's record of the game and, if it ends the series, R262's
  rating move commit in one transaction.

  TRUST BOUNDARY: never exposed to anon or authenticated. `state` holds both
  sides' frozen trios -- the opponent's deck names and lists, which R259 keeps
  from each player -- and both current picks, which R259 hides until both are
  in. A client learns about its series only through the server's projection
  (GET /api/series/:id), which shows the opponent only which slots they have
  played and whether they have picked. Like public.matches, there is
  deliberately no policy and no grant for any client role.$$;

comment on column public.series.p1_profile_id is
  $$Series seat p1: the older ticket, or the room host (R259). It goes first in
  odd games; p2 in even games.$$;

comment on column public.series.next_match_id is
  $$R263: the match id of the game being picked for or played, reserved
  before its match exists -- so, by design, no foreign key into
  public.matches. While status = 'playing' it is the match in play, which is
  how a game's result finds its series.$$;

comment on column public.series.pick_deadline_at is
  $$R260: when the pick phase closes (SERIES_PICK_SECONDS after it opened);
  NULL outside a pick phase. The sweeper (R263) enforces it.$$;

comment on column public.series.version is
  $$R263: the compare-and-set counter. Each transition writes version + 1
  over exactly the version it was computed from.$$;

comment on column public.series.state is
  $$Everything else of the server's SeriesRow, read and written whole:
  {sides: [{trio, wins, pick}, x2], games: [{gameNo, matchId, slots, first,
  winner, reason}], seedBase, endReason, ratingBefore, ratingAfter}. `sides`
  and `games` are ordered by series seat p1, p2. Hidden information (see the
  table comment).$$;

-- R263's sweeper, and "is this profile in a series" for the queue, read only
-- the series that are not over -- a small, shrinking fraction of the table
-- once series accumulate -- so the status index covers exactly those.
create index if not exists series_active_idx
  on public.series (status, created_at)
  where status <> 'over';

-- "The series whose game in play is this match": a game's result reads it
-- inside its transaction (R263). One series per reserved id -- a match is a
-- game of at most one series -- so the index is unique as well.
create unique index if not exists series_next_match_id_key
  on public.series (next_match_id);

-- A profile's series (the queue's "not in a series" check, SPEC §9.5), and
-- the lookups the profile foreign keys make.
create index if not exists series_p1_profile_id_idx on public.series (p1_profile_id);
create index if not exists series_p2_profile_id_idx on public.series (p2_profile_id);

-- "The series one of whose games was played as this match", whatever its
-- status: the board's series banner asks it after a game ends. A GIN index
-- with jsonb_path_ops over the games array answers the containment query
--   state -> 'games' @> '[{"matchId": "<id>"}]'
-- directly, without a side table to keep in step with the document.
create index if not exists series_games_idx
  on public.series using gin ((state -> 'games') jsonb_path_ops);

alter table public.series enable row level security;

-- TRUST BOUNDARY (see the table comment): RLS on, and no policy of any kind.
-- RLS default-deny plus zero grants makes this table unreadable and
-- unwritable from the Data API under any circumstance; only service_role
-- (BYPASSRLS) touches it.
revoke all on public.series from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Closing summary of what this schema lets each role do.
-- ----------------------------------------------------------------------------
-- anon:          nothing.
-- authenticated: nothing -- no SELECT, INSERT, UPDATE or DELETE, and no
--                policy. Picks and the opponent's trio are hidden information
--                (R259); the series screen is the server's projection.
-- service_role:  BYPASSRLS covers reads/writes directly: create, the
--                compare-and-set update, and the lookups by id, by
--                next_match_id, by player and by game.
-- ============================================================================
