-- ============================================================================
-- Migration 0006: The deck library
-- ============================================================================
-- Serves SPEC.md §11 R171 ("The deck library") and R172 ("A match may use a
-- library deck"), BUILD M9-T1. Beside §9.4's one loadout, an account keeps
-- up to MAX_LIBRARY_DECKS (apps/server/src/config.ts) named decks, each
-- saved on its own.
--
-- Deliberately unlike 0003:
--   * The deck, not a loadout, is the unit of persistence. R171: L1 and L4
--     are loadout rules and do not apply between library decks, so there is
--     no cross-deck invariant for a transaction or a unique index to hold,
--     and a card may sit in any number of rows here.
--   * `cards` is a text[] rather than a join table on public.cards. A deck
--     is re-validated against the current catalog whenever it is used
--     (R171), by @jackioh/validator in the server, so an id the catalog no
--     longer carries is L6's to report rather than a foreign key's to
--     refuse -- a catalog release must never make a library row unwritable.
--   * No catalog_version column, for the same reason.
--   * No SECURITY DEFINER writer. The server validates with the shared
--     validator and writes through service_role; the cap (R171) is counted
--     under a lock on the profile row in src/db/store.ts.
--
-- Apply order: 0001 (`app.current_profile_id`, `app.set_updated_at`,
-- `public.profiles`) -> ... -> 0006 (this file). Only ADDS objects.
-- ============================================================================

create table if not exists public.decks (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  name        text not null,
  cards       text[] not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists decks_profile_idx on public.decks (profile_id, updated_at desc);

comment on table public.decks is
  $$SPEC §11 R171: one named deck in an account's library, independent of
  the §9.4 loadout. No client-writable path (SPEC §9.1: "Deck library |
  Server validates and stores | Propose"); the server writes it after
  @jackioh/validator's validateDeck accepts the deck. R172: a match freezes
  a copy of `cards` into its ticket or room, so editing or deleting a row
  never reaches a match already made.$$;

alter table public.decks enable row level security;

drop trigger if exists decks_set_updated_at on public.decks;
create trigger decks_set_updated_at
  before update on public.decks
  for each row execute function app.set_updated_at();

-- SPEC §9.1: a profile reads only its own rows. No insert/update/delete
-- policy exists for any client role.
drop policy if exists decks_select_own on public.decks;
create policy decks_select_own
  on public.decks
  for select
  to authenticated
  using (profile_id = app.current_profile_id());

revoke all on public.decks from public, anon, authenticated;
grant select on public.decks to authenticated;

-- ----------------------------------------------------------------------------
-- anon:          nothing.
-- authenticated: SELECT on its own rows only (RLS). No INSERT, UPDATE or
--                DELETE grant or policy.
-- service_role:  BYPASSRLS covers reads and writes, as for every table in
--                0002-0004; apps/server is the only writer.
-- ============================================================================
