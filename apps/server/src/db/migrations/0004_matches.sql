-- ============================================================================
-- Migration 0004: Matches, action log, matchmaking, results
-- ============================================================================
-- Serves SPEC §9.3 (Engine requirements) -- the append-only action log:
--   "Append-only action log per match; snapshots are a later optimisation."
--   "Every action carries a client nonce, deduped server-side."
--   "Seeded RNG only ... `(seed, log)` reconstructs any match."
-- and SPEC §9.5 (Matchmaking and lifecycle) -- room-code challenge, the
--   ranked queue, the turn/prompt/disconnect/ceiling clocks of R79, Elo
--   rating, and "Every ending records a result and clears both players'
--   in-match state."
-- See also SPEC §2.5 (Ending the game), SPEC R79 (lifecycle defaults),
-- ARCHITECTURE-CCG.md §2.1/§2.2 (stateful actor + action log), §6/§6.2
-- (matchmaking, abandonment), BUILD.md M6-T4, M7-T1, M7-T2, M7-T3.
--
-- Apply order: 0001 (schema `app`, `app.settings`, `app.current_profile_id`,
-- `app.deny_row_mutation`, `public.profiles`) -> 0002 (`public.cards`,
-- `app.assert_catalog_version`) -> 0003 (`public.loadouts` and friends,
-- `app.resolve_deck`) -> 0004 (this file: `public.matches`,
-- `public.match_actions`, `public.tickets`, `public.results`, the FK from
-- `profiles.current_match_id`, and the match/queue lifecycle functions).
--
-- This file only ADDS objects, plus one ALTER TABLE (the profiles FK 0001
-- deliberately left off -- see its own section below). It never redefines
-- anything 0001-0003 already created.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- public.matches -- one row per match; the trust boundary for hidden state.
-- ----------------------------------------------------------------------------
create table if not exists public.matches (
  id                 uuid primary key default gen_random_uuid(),
  room_code          text,
  status             text not null,
  seed               text not null,
  p1_profile_id      uuid not null references public.profiles(id),
  p2_profile_id      uuid references public.profiles(id),
  p1_deck            jsonb not null,
  p2_deck            jsonb,
  catalog_version    text not null,
  last_seq           bigint not null default 0,
  turn_deadline_at   timestamptz,
  prompt_deadline_at timestamptz,
  p1_disconnected_at timestamptz,
  p2_disconnected_at timestamptz,
  grace_deadline_at  timestamptz,
  ceiling_at         timestamptz not null,
  created_at         timestamptz not null default now(),
  started_at         timestamptz,
  ended_at           timestamptz,
  constraint matches_status_check check (
    -- SPEC §9.5 / §2.5 lifecycle: a room waits `open`, a paired match runs
    -- `live`, every ending (hero death, draw, concede, disconnect,
    -- ceiling, turn cap) flips it to `over`.
    status in ('open', 'live', 'over')
  ),
  constraint matches_room_code_format_check check (
    -- SPEC R79: "room codes of 6 characters from the invite-code
    -- alphabet." SPEC §9.4 defines that alphabet only in prose ("32-symbol
    -- alphabet without 0/O/1/I/l"); this migration pins the literal
    -- ordered string -- digits 2-9 (8 symbols) plus A-Z minus I, O (24
    -- symbols) = 32 symbols, so each character carries log2(32) = 5 bits
    -- and a 6-character code carries exactly 30 bits (~1.07e9 codes).
    -- That derivation is SPEC §11 R104, which writes this alphabet out and
    -- explains why §9.4's "32 symbols without 0/O/1/I/l" was unsatisfiable
    -- (dropping those from 36 alphanumerics leaves 31): upper case only,
    -- dropping 0/1/I/O, gives exactly 32, so a 6-character code is 30 bits.
    -- R110 governs reuse and R149 the bounded mint.
    room_code ~ '^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$'
  ),
  constraint matches_players_differ_check check (
    p1_profile_id is distinct from p2_profile_id
  ),
  constraint matches_p2_required_when_not_open_check check (
    -- SPEC §9.5: p2 is only ever absent "while a room is open and waiting
    -- for the second player" -- every other status implies p2 is set.
    status = 'open' or p2_profile_id is not null
  )
);

comment on table public.matches is
  $$SPEC §9.3: "`(seed, log)` reconstructs any match" -- this row holds the
  seed and both frozen decks; public.match_actions holds the log. SPEC
  §9.5: matchmaking and lifecycle -- room-code challenge (room_code) and
  the ranked queue (app.start_match) both create a row here, and the R79
  clocks (turn/prompt/disconnect/ceiling) live on the row so a
  reconnecting client and a restarting server both read them from one
  place (SPEC §9.5: "the grace countdown is stored on the match so both
  clients show it").

  TRUST BOUNDARY: this table is never exposed to anon or authenticated
  (see the RLS section below). (seed, log) together reconstruct library
  order and both hands, which SPEC §9.1/§9.8 list as exactly the data a
  client must never see, and SPEC §9.5 says "Reconnect gets a fresh full
  view, never a log replay." A client learns about its match only through
  the server's API projection and the WebSocket `viewFor` (SPEC §9.1,
  §9.2, §10.8) -- never by reading this table. This is a deliberate
  design decision, not an oversight: no SELECT policy or grant exists for
  anon/authenticated on this table anywhere in this migration.$$;

comment on column public.matches.room_code is
  $$SPEC §9.5: "Direct challenge by room code ... ships before the ranked
  queue." Null for queue-paired matches (app.start_match never sets it).
  See matches_room_code_format_check for the alphabet derivation.$$;

comment on column public.matches.seed is
  $$SPEC §9.3: "(seed, log) reconstructs any match" and "Seeded RNG only."
  Combined with public.match_actions this is the entire hidden game
  state; see the table comment's TRUST BOUNDARY note.$$;

comment on column public.matches.p1_deck is
  $$SPEC §9.4/§9.5: "Decks are frozen into the queue ticket" -- and, for a
  room challenge, into the match at creation. The frozen ordered card-id
  list from app.resolve_deck (0003), never re-read from public.loadouts
  once the match exists.$$;

comment on column public.matches.p2_deck is
  $$Same shape as p1_deck. Null while a room is `open` and waiting for a
  second player; set by app.join_room when the room is claimed.$$;

comment on column public.matches.last_seq is
  $$The action log's high-water mark (SPEC §9.3). app.append_match_action
  reads and increments this under a row lock so the actor can append the
  next action without scanning public.match_actions for max(seq).$$;

comment on column public.matches.turn_deadline_at is
  $$R79: the 75 s turn clock, owned by the active player and paused while
  a non-active-player prompt is open (SPEC §9.5).$$;

comment on column public.matches.prompt_deadline_at is
  $$R79: the 30 s clock on a prompt held by the non-active player (e.g. a
  trap firing on the opponent's turn); its expiry answers only that
  prompt via the AI policy and never ends the turn (SPEC §2.5, R79).$$;

comment on column public.matches.p1_disconnected_at is
  $$R79 / SPEC §9.5: when p1 went offline, or null while connected. Feeds
  grace_deadline_at; "the clock keeps running while a player is
  disconnected."$$;

comment on column public.matches.p2_disconnected_at is
  $$Same as p1_disconnected_at, for p2.$$;

comment on column public.matches.grace_deadline_at is
  $$R79: the 60 s disconnect grace deadline. SPEC §9.5: "the grace
  countdown is stored on the match so both clients show it." Expiry is
  the `disconnectExpired` action (a loss for the disconnected player).$$;

comment on column public.matches.ceiling_at is
  $$R79: the hard 60-minute wall-clock ceiling. SPEC §9.5: "the hard
  wall-clock ceiling (60 minutes) ends it as a draw through the
  `ceilingReached` action ... a reaper resolves anything past the
  ceiling." Set to 'infinity' by app.create_room -- an `open` room is
  never reaped, since app.reap_stale_matches only scans status = 'live'
  -- and re-stamped to now() + 60 minutes by app.join_room / directly at
  insert by app.start_match, once the match is actually live. The clock
  counts from when both players are present, not from when a room sits
  open waiting.$$;

comment on column public.matches.started_at is
  $$When the match went `live` (both players present). Null for an `open`
  room still waiting for a second player.$$;

comment on column public.matches.ended_at is
  $$When the match went `over`. Set once, by app.end_match.$$;

-- SPEC §9.5: a room code is only meaningful while its room can still be
-- joined. SPEC §11 R110: a code is reusable once its match ends.
-- Chosen: reusable -- the partial index only enforces uniqueness while
-- status <> 'over', so a finished match's code can be reissued to a new
-- room instead of the 32^6 code space slowly filling with dead codes.
create unique index if not exists matches_room_code_open_key
  on public.matches (room_code)
  where room_code is not null and status <> 'over';

-- SPEC §9.5: "a reaper resolves anything past the ceiling" -- the
-- reaper's scan predicate is exactly (status = 'live' and ceiling_at <
-- now()), which this index serves directly.
create index if not exists matches_status_ceiling_at_idx
  on public.matches (status, ceiling_at);

-- ARCHITECTURE-CCG.md §2.2 / SPEC §9.5: "A crashed actor rebuilds its
-- state by folding (seed, log)" -- a restarting server finds every
-- `live` match to rebuild via this index (see app.live_matches below).
create index if not exists matches_status_created_at_idx
  on public.matches (status, created_at);

create index if not exists matches_p1_profile_id_idx on public.matches (p1_profile_id);
create index if not exists matches_p2_profile_id_idx on public.matches (p2_profile_id);

alter table public.matches enable row level security;

-- TRUST BOUNDARY (full SPEC citation in the table comment above):
-- deliberately NO select policy and NO grant for anon/authenticated here.
-- RLS default-deny plus zero grants means this table is unreadable from
-- the Data API under any circumstance; only service_role (BYPASSRLS) and
-- the SECURITY DEFINER functions below can read or write it.

-- ----------------------------------------------------------------------------
-- public.match_actions -- the append-only action log (SPEC §9.3).
-- ----------------------------------------------------------------------------
create table if not exists public.match_actions (
  match_id    uuid not null references public.matches(id) on delete cascade,
  seq         bigint not null,
  player_id   uuid references public.profiles(id),
  player_seat text not null,
  nonce       text not null,
  action      jsonb not null,
  at          timestamptz not null default now(),
  primary key (match_id, seq),
  constraint match_actions_player_seat_check check (
    player_seat in ('p1', 'p2', 'server')
  ),
  constraint match_actions_nonce_key unique (match_id, nonce)
);

comment on table public.match_actions is
  $$SPEC §9.3: "Append-only action log per match; snapshots are a later
  optimisation." ARCHITECTURE-CCG.md §2.2: "Append each action as it
  resolves; don't persist snapshots. Periodic snapshots are an
  optimisation for later." Combined with matches.seed this reconstructs
  any match exactly (SPEC §9.3). Append-only is a database property, not
  a convention: see match_actions_deny_mutation below.

  TRUST BOUNDARY: never exposed to anon or authenticated, for the same
  reason as public.matches (see its table comment) -- this log holds
  every hidden action (draws, the opponent's hand contents at play time,
  trap identities before they flip) in order.$$;

comment on column public.match_actions.seq is
  $$Per-match sequence number, assigned by app.append_match_action from
  matches.last_seq under a row lock. Monotonic and gapless per match_id.$$;

comment on column public.match_actions.player_id is
  $$Null for the server-only actions of R79/SPEC §9.5 -- `timeout`,
  `disconnectExpired`, `ceilingReached` -- which have no author
  (packages/shared/src/actions.ts ActionBody).$$;

comment on column public.match_actions.player_seat is
  $$Redundant with player_id but always present, including for
  server-authored rows (player_seat = 'server', player_id null) -- lets a
  reader group or filter by seat with no join back to public.matches.$$;

comment on column public.match_actions.nonce is
  $$SPEC §9.3: "Every action carries a client nonce, deduped server-side."
  See match_actions_nonce_key and app.append_match_action, which returns
  the original seq on a reused nonce (BUILD M6-T4 acceptance).$$;

comment on column public.match_actions.action is
  $$The Action union of packages/shared/src/actions.ts (ActionBody plus
  playerId and nonce), stored as-is. Not independently constrained here
  -- `reduce` is the sole authority on what is a legal action (SPEC §9.3:
  "`reduce` refuses illegal actions itself"); this table only ever stores
  actions `reduce` already accepted.$$;

-- SPEC §9.3's log is append-only as a database property: attach
-- app.deny_row_mutation() (0001) so no role -- service_role included --
-- can update or delete a logged action after the fact. A correction is a
-- new action, never an edit to history.
drop trigger if exists match_actions_deny_mutation on public.match_actions;
create trigger match_actions_deny_mutation
  before update or delete on public.match_actions
  for each row execute function app.deny_row_mutation();

alter table public.match_actions enable row level security;

-- TRUST BOUNDARY: same reasoning as public.matches above -- no select
-- policy, no grant, for anon or authenticated. (seed, log) together
-- reconstruct library order and both hands (SPEC §9.1/§9.8); SPEC §9.5:
-- "Reconnect gets a fresh full view, never a log replay." Only
-- service_role and app.append_match_action / app.live_matches touch this
-- table.

-- ----------------------------------------------------------------------------
-- public.tickets -- the matchmaking queue (SPEC §9.5, BUILD M7-T3).
-- ----------------------------------------------------------------------------
create table if not exists public.tickets (
  id              uuid primary key default gen_random_uuid(),
  profile_id      uuid not null references public.profiles(id) on delete cascade,
  slot            int not null,
  rating          int not null,
  frozen_deck     jsonb not null,
  catalog_version text not null,
  status          text not null default 'queued',
  enqueued_at     timestamptz not null default now(),
  claimed_at      timestamptz,
  match_id        uuid references public.matches(id) on delete set null,
  constraint tickets_slot_check check (slot between 1 and 3),
  constraint tickets_status_check check (status in ('queued', 'claimed', 'cancelled'))
);

comment on table public.tickets is
  $$SPEC §9.5: "Enqueue asserts the account is active and not in a match,
  validates the loadout, freezes the chosen deck into the ticket and
  returns the ticket id." BUILD M7-T3. No client write path exists (no
  insert/update/delete grant or policy for any client role) -- enqueue is
  a server endpoint that asserts status, validates the loadout and calls
  the freezing logic before this table is ever touched.$$;

comment on column public.tickets.frozen_deck is
  $$SPEC §9.5: "freezes the chosen deck into the ticket." ARCHITECTURE-
  CCG.md §5.4: "Do not resolve from the database at match start" --
  editing public.loadouts after enqueue cannot change this ticket's deck
  (BUILD M7-T3 acceptance). Populated from app.resolve_deck (0003) once,
  at enqueue time, never re-read afterwards.$$;

comment on column public.tickets.status is
  $$'queued' while waiting to pair. 'claimed' once app.claim_ticket_pair
  wins the race for this ticket (match_id is then set). 'cancelled' on
  withdrawal, or when app.end_match clears a stray 'queued' ticket left
  over because the profile ended up in a match a different way (e.g. it
  accepted a room challenge while still queued) -- guards
  tickets_profile_queued_key so the profile can queue again immediately.$$;

-- SPEC §9.5: "not in a match" and "not already queued" -- one live
-- ticket per profile, race-proof: a second concurrent enqueue hits this
-- index, not an application-level check that could race.
create unique index if not exists tickets_profile_queued_key
  on public.tickets (profile_id)
  where status = 'queued';

-- SPEC §9.5: "Pairing runs on enqueue plus a sweeper every few seconds;
-- the window widens ±50 rating every 10 s from ±100 and is uncapped
-- after 60 s." The pairing scan and the widening window both filter and
-- order by exactly these three columns.
create index if not exists tickets_pairing_scan_idx
  on public.tickets (status, rating, enqueued_at);

alter table public.tickets enable row level security;

-- SPEC §9.1-style projection: a profile may read its own tickets (queue
-- status, rating context) but never another profile's, and never write
-- any row directly -- enqueue/cancel are server endpoints, not exposed
-- here as a client-writable policy.
drop policy if exists tickets_select_own on public.tickets;
create policy tickets_select_own
  on public.tickets
  for select
  to authenticated
  using (profile_id = app.current_profile_id());

-- ----------------------------------------------------------------------------
-- public.results -- one row per terminal match (SPEC §2.5, §9.5, BUILD M7-T2).
-- ----------------------------------------------------------------------------
create table if not exists public.results (
  match_id          uuid primary key references public.matches(id) on delete cascade,
  p1_profile_id     uuid not null references public.profiles(id),
  p2_profile_id     uuid not null references public.profiles(id),
  winner_profile_id uuid references public.profiles(id),
  reason            text not null,
  turns             int not null,
  p1_rating_before  int not null,
  p1_rating_after   int not null,
  p2_rating_before  int not null,
  p2_rating_after   int not null,
  ended_at          timestamptz not null default now(),
  constraint results_reason_check check (
    -- Must match packages/shared/src/events.ts GameOverReason exactly --
    -- see the reason column comment.
    reason in (
      'hero-death', 'both-heroes-dead', 'concede', 'draw-accepted',
      'turn-cap', 'disconnect', 'match-ceiling'
    )
  )
);

comment on table public.results is
  $$SPEC §2.5 (ending the game) and §9.5: "Every ending records a result
  and clears both players' in-match state." One row per match, written
  once by app.end_match. p1_profile_id/p2_profile_id are denormalised
  from public.matches (which the client can never read -- see its table
  comment) so the read policy below is self-contained and needs no join
  into a table the client has zero access to.$$;

comment on column public.results.winner_profile_id is
  $$Null means a draw. SPEC §2.5 lists both heroes dead in the same
  check, a draw offer accepted, the end of the 30th turn (turn cap) and
  the hard match ceiling as the four draw conditions.$$;

comment on column public.results.reason is
  $$Exactly the seven GameOverReason strings of
  packages/shared/src/events.ts, kept in lockstep by results_reason_check.$$;

comment on column public.results.p1_rating_before is
  $$Elo before/after (K = 32, starting at 1000; R79). The update itself
  is computed in apps/server/src/config.ts, not here -- app.end_match
  takes the *_after values as arguments so the K-factor and starting
  rating are not duplicated in SQL.$$;

create index if not exists results_p1_ended_at_idx on public.results (p1_profile_id, ended_at desc);
create index if not exists results_p2_ended_at_idx on public.results (p2_profile_id, ended_at desc);

alter table public.results enable row level security;

-- A profile reads a result it played in; no client writes anywhere.
drop policy if exists results_select_participant on public.results;
create policy results_select_participant
  on public.results
  for select
  to authenticated
  using (
    p1_profile_id = app.current_profile_id()
    or p2_profile_id = app.current_profile_id()
  );

-- ----------------------------------------------------------------------------
-- profiles.current_match_id -> matches(id) -- the FK 0001 deliberately
-- left off, since public.matches did not exist yet at that point.
-- ----------------------------------------------------------------------------
-- SPEC §9.5: "Every ending records a result and clears both players'
-- in-match state." ARCHITECTURE-CCG.md §6.2: "The recurring bug is a
-- crashed actor leaving two players permanently unable to queue." This
-- FK does not by itself prevent that bug -- app.end_match and
-- app.reap_stale_matches are what actually clear current_match_id -- but
-- it does guarantee current_match_id can never point at a match id that
-- was never created, and `on delete set null` means even a hard-deleted
-- match row (never done in ordinary operation, but not forbidden) cannot
-- leave a profile permanently pointed at nothing that exists.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_current_match_id_fkey'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_current_match_id_fkey
      foreign key (current_match_id) references public.matches(id)
      on delete set null;
  end if;
end $$;

-- ============================================================================
-- Functions -- all SECURITY DEFINER in `app`, never in `public`, with an
-- explicit safe search_path (empty; every reference below is schema-
-- qualified, matching 0002's convention) so none of them can be
-- redirected by a caller's search_path.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- app.create_room / app.start_match -- the two match-creation paths.
-- ----------------------------------------------------------------------------
-- SPEC §9.5: "Direct challenge by room code ... ships before the ranked
-- queue" and, for the queue, "pair(ticketA, ticketB): create match, spawn
-- actor, seed with both frozen decks" (ARCHITECTURE-CCG.md §6). These are
-- genuinely different shapes -- a room match is created `open` with only
-- p1 known; a queue match is created `live` with both players already
-- known -- so this migration writes two functions rather than one that
-- branches on which arguments are null.
create or replace function app.create_room(
  p_profile_id      uuid,
  p_room_code       text,
  p_seed            text,
  p_frozen_deck     jsonb,
  p_catalog_version text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_match_id uuid;
begin
  perform app.assert_catalog_version(p_catalog_version);

  insert into public.matches (
    room_code, status, seed, p1_profile_id, p1_deck, catalog_version, ceiling_at
  ) values (
    p_room_code, 'open', p_seed, p_profile_id, p_frozen_deck, p_catalog_version,
    -- Irrelevant while status = 'open' (the reaper only scans 'live');
    -- app.join_room re-stamps this to a real deadline once claimed. See
    -- the matches.ceiling_at column comment.
    'infinity'::timestamptz
  )
  returning id into v_match_id;

  update public.profiles set current_match_id = v_match_id where id = p_profile_id;

  return v_match_id;
end;
$$;

comment on function app.create_room(uuid, text, text, jsonb, text) is
  $$SPEC §9.5: creates an `open` room for direct challenge by room code,
  with only p1 known. Sets p1's current_match_id. Paired with
  app.join_room, which claims the room and flips it to `live`.$$;

create or replace function app.start_match(
  p_p1_profile_id   uuid,
  p_p2_profile_id   uuid,
  p_p1_deck         jsonb,
  p_p2_deck         jsonb,
  p_seed            text,
  p_catalog_version text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_match_id uuid;
begin
  perform app.assert_catalog_version(p_catalog_version);

  if p_p1_profile_id = p_p2_profile_id then
    raise exception 'app.start_match: a profile cannot be matched against itself';
  end if;

  insert into public.matches (
    status, seed, p1_profile_id, p2_profile_id, p1_deck, p2_deck,
    catalog_version, ceiling_at, started_at
  ) values (
    -- R79: the hard 60-minute wall-clock ceiling, counted from now
    -- because a queue match is live immediately (both players known).
    'live', p_seed, p_p1_profile_id, p_p2_profile_id, p_p1_deck, p_p2_deck,
    p_catalog_version, now() + interval '60 minutes', now()
  )
  returning id into v_match_id;

  update public.profiles
  set current_match_id = v_match_id
  where id in (p_p1_profile_id, p_p2_profile_id);

  return v_match_id;
end;
$$;

comment on function app.start_match(uuid, uuid, jsonb, jsonb, text, text) is
  $$SPEC §9.5 / ARCHITECTURE-CCG.md §6 "pair(ticketA, ticketB)": creates a
  `live` match with both players and both frozen decks already known
  (the ranked-queue path), sets both players' current_match_id, and
  stamps ceiling_at/started_at immediately since the match starts live.
  Call after app.claim_ticket_pair has won the race for both tickets.$$;

-- ----------------------------------------------------------------------------
-- app.join_room -- claims an open room (the other half of app.create_room).
-- ----------------------------------------------------------------------------
create or replace function app.join_room(
  p_room_code       text,
  p_profile_id      uuid,
  p_frozen_deck     jsonb,
  p_catalog_version text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_match_id      uuid;
  v_p1_profile_id uuid;
  v_status        text;
begin
  perform app.assert_catalog_version(p_catalog_version);

  -- SPEC §9.5: claim an open room atomically. SELECT ... FOR UPDATE locks
  -- the row for the rest of this call (a function invocation runs inside
  -- one transaction); a second concurrent join_room for the same
  -- room_code blocks on this lock until the first commits, then observes
  -- status = 'live' and is rejected below -- two players cannot both
  -- claim the same room.
  select id, p1_profile_id, status
  into v_match_id, v_p1_profile_id, v_status
  from public.matches
  where room_code = p_room_code
  for update;

  if not found then
    raise exception 'app.join_room: room % not found', p_room_code;
  end if;

  if v_status <> 'open' then
    raise exception 'app.join_room: room % is no longer open', p_room_code;
  end if;

  if v_p1_profile_id = p_profile_id then
    raise exception 'app.join_room: cannot join your own room';
  end if;

  update public.matches
  set p2_profile_id = p_profile_id,
      p2_deck        = p_frozen_deck,
      status         = 'live',
      started_at     = now(),
      -- R79: stamp the real 60-minute ceiling from when the match
      -- actually goes live, not from when the room was created.
      ceiling_at     = now() + interval '60 minutes'
  where id = v_match_id;

  update public.profiles
  set current_match_id = v_match_id
  where id in (v_p1_profile_id, p_profile_id);

  return v_match_id;
end;
$$;

comment on function app.join_room(text, uuid, jsonb, text) is
  $$SPEC §9.5: claims an `open` room by code, atomically (row-locked via
  SELECT ... FOR UPDATE inside this function's single transaction), sets
  p2 and its frozen deck, flips the match to `live`, sets both players'
  current_match_id, and stamps ceiling_at. Rejects joining your own room
  and a room that is no longer open.$$;

-- ----------------------------------------------------------------------------
-- app.append_match_action -- the one write path for public.match_actions.
-- ----------------------------------------------------------------------------
create or replace function app.append_match_action(
  p_match_id  uuid,
  p_seat      text,
  p_player_id uuid,
  p_nonce     text,
  p_action    jsonb
) returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_seq bigint;
begin
  -- SPEC §9.3: "Every action carries a client nonce, deduped
  -- server-side." BUILD M6-T4 acceptance: a reused nonce returns the
  -- original ack.
  select seq into v_seq
  from public.match_actions
  where match_id = p_match_id and nonce = p_nonce;

  if found then
    return v_seq;
  end if;

  -- Assign seq from matches.last_seq under a row lock (UPDATE ...
  -- RETURNING takes that lock implicitly), so concurrent appends to the
  -- same match serialize on this row instead of racing to pick the same
  -- seq (see the matches.last_seq column comment).
  update public.matches
  set last_seq = last_seq + 1
  where id = p_match_id
  returning last_seq into v_seq;

  if not found then
    raise exception 'app.append_match_action: match % not found', p_match_id;
  end if;

  insert into public.match_actions (match_id, seq, player_id, player_seat, nonce, action)
  values (p_match_id, v_seq, p_player_id, p_seat, p_nonce, p_action);

  return v_seq;
exception
  when unique_violation then
    -- A concurrent call with the same (match_id, nonce) won the race
    -- between our SELECT above and our INSERT; hand back its seq instead
    -- of raising, so "reused nonce returns the original ack" holds even
    -- under contention.
    select seq into v_seq
    from public.match_actions
    where match_id = p_match_id and nonce = p_nonce;

    return v_seq;
end;
$$;

comment on function app.append_match_action(uuid, text, uuid, text, jsonb) is
  $$SPEC §9.3: the append-only log's one write path. Assigns seq from
  matches.last_seq under a row lock; on a duplicate (match_id, nonce)
  returns the existing seq instead of raising (BUILD M6-T4).$$;

-- ----------------------------------------------------------------------------
-- app.claim_ticket_pair -- the one atomic statement matchmaking pairs on.
-- ----------------------------------------------------------------------------
create or replace function app.claim_ticket_pair(
  p_ticket_a uuid,
  p_ticket_b uuid,
  p_match_id uuid
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claimed int;
begin
  -- SPEC §9.5: "both tickets are claimed in one atomic statement."
  -- ARCHITECTURE-CCG.md §6: "Claim both tickets in one atomic statement,
  -- or two matchers pair the same player into two matches." This single
  -- UPDATE ... WHERE status = 'queued' is that statement: two concurrent
  -- matchers racing over the same ticket cannot both flip it to
  -- 'claimed', so at most one of two competing app.claim_ticket_pair
  -- calls can return true for a given ticket (BUILD M7-T3 race test).
  with claimed as (
    update public.tickets
    set status = 'claimed', claimed_at = now(), match_id = p_match_id
    where id in (p_ticket_a, p_ticket_b)
      and status = 'queued'
    returning id
  )
  select count(*) into v_claimed from claimed;

  return v_claimed = 2;
end;
$$;

comment on function app.claim_ticket_pair(uuid, uuid, uuid) is
  $$SPEC §9.5 / ARCHITECTURE-CCG.md §6: one UPDATE ... WHERE id IN (a, b)
  AND status = 'queued' RETURNING, true only when it claimed exactly 2.
  See the function body for the exact statement.$$;

-- ----------------------------------------------------------------------------
-- app.end_match -- the one path that terminates a match.
-- ----------------------------------------------------------------------------
create or replace function app.end_match(
  p_match_id        uuid,
  p_winner          uuid,
  p_reason          text,
  p_turns           int,
  p_p1_rating_after int,
  p_p2_rating_after int
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_match     public.matches%rowtype;
  v_p1_before int;
  v_p2_before int;
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
  -- comment for why the Elo math itself is not duplicated here.
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

comment on function app.end_match(uuid, uuid, text, int, int, int) is
  $$SPEC §2.5/§9.5: flips the match to 'over', writes the one results row
  with before/after ratings, updates both profiles.rating, clears both
  current_match_id and any stray queued ticket. Idempotent on a repeat
  call for an already-'over' match. Takes *_rating_after as arguments --
  the Elo update (K = 32, start 1000; R79) is computed in
  apps/server/src/config.ts, so its constants are not duplicated in SQL.$$;

-- ----------------------------------------------------------------------------
-- app.reap_stale_matches -- SPEC §9.5's reaper.
-- ----------------------------------------------------------------------------
-- SPEC §9.5: "the hard wall-clock ceiling (60 minutes) ends it as a draw
-- through the `ceilingReached` action ... a reaper resolves anything past
-- the ceiling." ARCHITECTURE-CCG.md §6.2: "Give matches a hard wall-clock
-- ceiling and run a reaper over anything past it" so a crashed actor
-- cannot leave two players stuck forever.
--
-- SPEC §11 R112: whether the reaper changes ratings. A draw's true Elo
-- delta is nonzero whenever the two players' ratings differ, but
-- computing that here would duplicate the K-factor/starting-rating
-- constants that apps/server/src/config.ts owns (see app.end_match). The
-- two options were (a) leave ratings untouched here and have the reaper
-- only mark the match for the server to finish with a real Elo update,
-- or (b) have the reaper fully resolve the match itself with a zero
-- rating delta. Chosen: (b) -- SPEC §9.5 says the reaper "resolves" stale
-- matches, and ARCHITECTURE-CCG.md §6.2 frames the bug to avoid as a
-- match left unresolved, not as a rating slightly off; a reaper that
-- only half-finishes the job (and depends on a server that may itself be
-- the crashed component) reintroduces exactly the stuck-match bug it
-- exists to prevent. A rating-accurate ceiling draw would need the
-- server itself to run this pass instead of, or in addition to, a
-- SQL-only job.
create or replace function app.reap_stale_matches() returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_match record;
  v_count int := 0;
begin
  for v_match in
    select id, p1_profile_id, p2_profile_id
    from public.matches
    where status = 'live' and ceiling_at < now()
    for update skip locked
  loop
    -- SPEC §11 R112: turns is not tracked on public.matches (the live turn
    -- counter lives only in the match actor's in-memory GameState), so a
    -- ceiling draw the reaper resolves records turns = 0 rather than the
    -- true count. A server-driven ceilingReached action (the normal
    -- path) always has the real turn count from GameState and should be
    -- preferred whenever the actor is still alive; this reaper is the
    -- last-resort path for when it is not.
    perform app.end_match(
      v_match.id,
      null,
      'match-ceiling',
      0,
      (select rating from public.profiles where id = v_match.p1_profile_id),
      (select rating from public.profiles where id = v_match.p2_profile_id)
    );

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

comment on function app.reap_stale_matches() is
  $$SPEC §9.5's reaper: ends every `live` match past ceiling_at as a draw
  with reason 'match-ceiling', ratings unchanged. See the R112
  comment above the function for the rating-delta and turns-count
  choices. SKIP LOCKED lets concurrent reaper runs split the work
  instead of double-processing the same match. Returns the number of
  matches reaped.$$;

-- ----------------------------------------------------------------------------
-- app.live_matches -- crash recovery (SPEC §9.5: "A crashed actor
-- rebuilds its state by folding (seed, log)").
-- ----------------------------------------------------------------------------
create or replace function app.live_matches() returns setof public.matches
language sql
security definer
stable
set search_path = ''
as $$
  select * from public.matches where status = 'live';
$$;

comment on function app.live_matches() is
  $$SPEC §9.5 / ARCHITECTURE-CCG.md §2.2: what a restarting server folds
  for crash recovery -- every `live` match, to fold (seed, log) for each
  via public.match_actions.$$;

-- ============================================================================
-- Explicit grants (default-deny first: revoke everything, then grant back
-- only what SPEC §9.1/§9.5/§9.8 allow). service_role's BYPASSRLS already
-- covers its reads/writes to these four tables directly, matching 0002's
-- convention; the EXECUTE grants below are what the API server and the
-- match actor actually call.
-- ============================================================================
revoke all on public.matches       from public, anon, authenticated;
revoke all on public.match_actions from public, anon, authenticated;
revoke all on public.tickets       from public, anon, authenticated;
revoke all on public.results       from public, anon, authenticated;

-- matches and match_actions: no grant at all for anon/authenticated (see
-- the TRUST BOUNDARY comments on both tables above).
grant select on public.tickets to authenticated;
grant select on public.results to authenticated;

revoke all on function app.create_room(uuid, text, text, jsonb, text)         from public;
revoke all on function app.start_match(uuid, uuid, jsonb, jsonb, text, text)  from public;
revoke all on function app.join_room(text, uuid, jsonb, text)                 from public;
revoke all on function app.append_match_action(uuid, text, uuid, text, jsonb) from public;
revoke all on function app.claim_ticket_pair(uuid, uuid, uuid)                from public;
revoke all on function app.end_match(uuid, uuid, text, int, int, int)         from public;
revoke all on function app.reap_stale_matches()                               from public;
revoke all on function app.live_matches()                                     from public;

grant execute on function app.create_room(uuid, text, text, jsonb, text)         to service_role;
grant execute on function app.start_match(uuid, uuid, jsonb, jsonb, text, text)  to service_role;
grant execute on function app.join_room(text, uuid, jsonb, text)                 to service_role;
grant execute on function app.append_match_action(uuid, text, uuid, text, jsonb) to service_role;
grant execute on function app.claim_ticket_pair(uuid, uuid, uuid)                to service_role;
grant execute on function app.end_match(uuid, uuid, text, int, int, int)         to service_role;
grant execute on function app.reap_stale_matches()                               to service_role;
grant execute on function app.live_matches()                                     to service_role;

-- ----------------------------------------------------------------------------
-- Closing summary of what this schema lets each role do.
-- ----------------------------------------------------------------------------
-- anon:          nothing on any of the four tables or eight functions.
-- authenticated: SELECT on public.tickets and public.results, filtered by
--                RLS to rows it participated in (its own tickets; results
--                where it is p1 or p2). No SELECT, INSERT, UPDATE or
--                DELETE of any kind on public.matches or
--                public.match_actions -- see their TRUST BOUNDARY table
--                comments: (seed, log) reconstructs hidden game state
--                (library order, both hands), so the client learns about
--                its match only via the server's API projection and the
--                WebSocket `viewFor`, never by reading these tables
--                (SPEC §9.1, §9.5, §9.8). No EXECUTE on any of the eight
--                app.* functions in this file.
-- service_role:  BYPASSRLS covers reads/writes to all four tables
--                directly; the eight app.* functions above are
--                additionally granted EXECUTE explicitly so the API
--                server and the match actor can call them.
-- ============================================================================
