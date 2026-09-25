-- ============================================================================
-- Migration 0008: Queue modes
-- ============================================================================
-- Serves SPEC.md §9.5 ("Modes") and SPEC §11 R257, R259 and R264, quoted:
--   R257: "The queue and the room challenge offer Best of 1 (one saved deck),
--   Best of 3 (a trio, R259) and All Random (R258). A ticket pairs only with a
--   ticket of the same mode".
--   R264: "A room is created in a mode, with the host's deck or trio frozen
--   into it. A joiner plays the room's mode".
-- and SPEC §9.8 (Abuse surface): "Deck swapped after matchmaking | Decks are
-- frozen into the ticket (9.4)" -- which now has to hold for a trio too: a
-- Best-of-3 player picks each game's deck from the trio frozen when they
-- queued (R259), never from the trio as it is saved later.
--
-- Apply order: 0004 (`public.tickets`, `public.matches`) -> ... -> 0007 ->
-- 0008 (this file) -> 0009.
--
-- This file only ADDS columns and constraints to 0004's tables and relaxes one
-- NOT NULL (tickets.slot, below). It never redefines a function. Safe to
-- re-apply: add-column-if-not-exists and drop-constraint-if-exists-then-add.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- public.tickets -- the queue ticket learns its mode (R257).
-- ----------------------------------------------------------------------------
-- Every ticket written before this migration was the only kind there was, a
-- one-deck ranked ticket, so the default 'bo1' is also the backfill: those
-- rows keep meaning what they meant.
alter table public.tickets add column if not exists mode text not null default 'bo1';

alter table public.tickets drop constraint if exists tickets_mode_check;
alter table public.tickets add constraint tickets_mode_check
  check (mode in ('bo1', 'bo3', 'random'));

comment on column public.tickets.mode is
  $$SPEC §11 R257: 'bo1' (Best of 1, one saved deck), 'bo3' (Best of 3, a
  trio) or 'random' (All Random, R258). A ticket pairs only with a ticket of
  the same mode; inside a mode §9.5's window and R166's order are unchanged.$$;

-- R259: "from the trio frozen when they queued". The Best-of-3 half of
-- "decks are frozen into the ticket": the trio's name and its three decks,
-- each with its name and cards, as the server's `FrozenTrio` -- frozen, like
-- frozen_deck, so editing or deleting the saved trio or any of its decks after
-- enqueue changes nothing about the series it pairs into.
alter table public.tickets add column if not exists frozen_trio jsonb;

-- A Best-of-3 ticket carries a trio and no other kind does -- the one
-- structural fact a pairing and a series read without re-checking. frozen_deck
-- stays `not null`: a Best-of-3 or All Random ticket stores '[]' there, since
-- it plays no one deck.
alter table public.tickets drop constraint if exists tickets_frozen_trio_check;
alter table public.tickets add constraint tickets_frozen_trio_check
  check ((mode = 'bo3') = (frozen_trio is not null));

-- And a frozen trio has its three decks: the series picks game n's deck by
-- slot (R259), and R260's timeout takes "the first unplayed deck in trio
-- order". `case` rather than `and`, because a CHECK does not promise to
-- short-circuit and jsonb_array_length raises on anything but an array.
alter table public.tickets drop constraint if exists tickets_frozen_trio_shape_check;
alter table public.tickets add constraint tickets_frozen_trio_shape_check
  check (
    frozen_trio is null
    or case when jsonb_typeof(frozen_trio -> 'decks') = 'array'
            then jsonb_array_length(frozen_trio -> 'decks') = 3
            else false end
  );

comment on column public.tickets.frozen_trio is
  $$SPEC §11 R259: a Best-of-3 ticket's trio, frozen at enqueue as
  {name, decks: [{name, cards}, x3]} in slot order. Null for every other
  mode (tickets_frozen_trio_check). Never re-read from public.trios.$$;

-- R257 made 0004's `slot` meaningless for a new ticket: a Best-of-1 ticket
-- freezes a saved deck (named by id, not by a place in a loadout), and a
-- Best-of-3 or All Random ticket has no single deck at all. The column and
-- its `slot between 1 and 3` check stay for the rows written before this
-- migration; new rows leave it NULL rather than write a slot that is not one.
alter table public.tickets alter column slot drop not null;

comment on column public.tickets.slot is
  $$0004's loadout slot (1..3) a ticket froze its deck from. NULL for every
  ticket written after 0008 (R257: a ticket freezes a saved deck or a trio,
  not a loadout slot); kept for the rows written before it.$$;

-- R257: "the queue population is reported per mode", and pairing reads the
-- open tickets of one mode, oldest first (R166). A partial index over exactly
-- the queued rows answers both.
create index if not exists tickets_queued_mode_idx
  on public.tickets (mode, enqueued_at)
  where status = 'queued';

-- ----------------------------------------------------------------------------
-- public.matches -- a room learns its mode (R264).
-- ----------------------------------------------------------------------------
-- A room is still a `public.matches` row with status = 'open' (0004), so its
-- mode lives on that row. NULL on a match that never was a room (a queue
-- pairing) and on a room written before this migration or by 0004's
-- app.create_room, which the server reads as 'bo1': before this migration a
-- room could be nothing else.
alter table public.matches add column if not exists room_mode text;

alter table public.matches drop constraint if exists matches_room_mode_check;
alter table public.matches add constraint matches_room_mode_check
  check (room_mode is null or room_mode in ('bo1', 'bo3', 'random'));

comment on column public.matches.room_mode is
  $$SPEC §11 R264: the mode a room was created in -- 'bo1', 'bo3' or
  'random' -- which a joiner must play. NULL for a queue-paired match, and for
  a room written before 0008 (read as 'bo1').$$;

-- R264: "with the host's deck or trio frozen into it". A Best-of-1 room keeps
-- the host's deck where 0004 kept it, in p1_deck; a Best-of-3 room keeps the
-- host's trio here and '[]' in p1_deck. The join makes the series (R264), and
-- the series freezes the trio a second time into its own row (0009), so this
-- column is read exactly once, at the join.
alter table public.matches add column if not exists room_trio jsonb;

-- `is not distinct from`, not `=`: a NULL room_mode would make `=` NULL, and a
-- CHECK passes on NULL, so a trio could hide on a row with no mode at all.
alter table public.matches drop constraint if exists matches_room_trio_check;
alter table public.matches add constraint matches_room_trio_check
  check ((room_mode is not distinct from 'bo3') = (room_trio is not null));

alter table public.matches drop constraint if exists matches_room_trio_shape_check;
alter table public.matches add constraint matches_room_trio_shape_check
  check (
    room_trio is null
    or case when jsonb_typeof(room_trio -> 'decks') = 'array'
            then jsonb_array_length(room_trio -> 'decks') = 3
            else false end
  );

comment on column public.matches.room_trio is
  $$SPEC §11 R264: a Best-of-3 room's host trio, frozen at create as
  {name, decks: [{name, cards}, x3]}. Null for every other row
  (matches_room_trio_check). Same TRUST BOUNDARY as the rest of this table:
  never readable by a client -- the opponent's deck names and lists are
  exactly what R259 keeps hidden.$$;

-- ----------------------------------------------------------------------------
-- Grants: nothing changes. public.tickets keeps 0004's select-own policy and
-- its SELECT grant to authenticated (a client reads its own ticket, mode and
-- frozen trio included -- the trio is its own); public.matches keeps no grant
-- and no policy for any client role. No client write path is added.
-- ============================================================================
