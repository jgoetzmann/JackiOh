-- ============================================================================
-- Migration 0003: Loadouts
-- ============================================================================
-- Serves SPEC.md §9.4 (Accounts, collection, loadouts), the loadout rules
-- L1-L6, quoted verbatim:
--   "Loadout rules, checked by one validator module shared by client and
--   server, at save and again at queue: L1 exactly 3 decks; L2 exactly
--   `DECK_SIZE` (20) cards per deck; L3 at most `MAX_COPIES` (1) of a card
--   per deck and no Token-tagged cards; L4 a card id appears in at most one
--   deck, also enforced by a unique index on `(profile_id, card_id)`; L5
--   copies across the loadout never exceed the quantity owned; L6 every
--   card exists in the current catalog version and is not banned. Saving is
--   `saveLoadout(profileId, catalogVersion, decks[3])`, which writes all
--   three decks in one transaction or nothing; there is no per-deck save.
--   A queue-time failure names the deck and the card. Decks are frozen into
--   the queue ticket."
-- and SPEC §9.1 (Trust model): "Loadout | Server validates and stores |
-- Propose", and SPEC §9.8 (Abuse surface): "Deck swapped after matchmaking
-- | Decks are frozen into the ticket (9.4)". See also SPEC §2.6
-- (Deckbuilding) and ARCHITECTURE-CCG.md §5 "Loadouts: three decks, no
-- shared cards".
--
-- Apply order: 0001 (schema `app`, `app.settings`/`app.setting`,
-- `app.catalog_version`, `app.current_profile_id`, `app.profile_is_active`,
-- `app.deny_row_mutation`, `app.set_updated_at`, `public.profiles`) ->
-- 0002 (`public.cards`, `public.collection`, `public.collection_grants`,
-- `app.assert_catalog_version`) -> 0003 (this file) -> 0004 (`matches`,
-- `tickets`; 0004 stores app.resolve_deck's result in `tickets.frozen_deck`
-- per SPEC §9.4 "Decks are frozen into the queue ticket").
--
-- This file only ADDS objects and never redefines anything from 0001 or
-- 0002. It assumes, unmodified, from those migrations: schema `app`;
-- `app.settings(key text primary key, value jsonb not null, updated_at)`;
-- `app.setting(p_key text) returns jsonb`; `app.catalog_version()`;
-- `app.current_profile_id()` (`auth.uid()`); `app.profile_is_active()`;
-- `app.deny_row_mutation()`; `app.set_updated_at()`;
-- `app.assert_catalog_version(p_version text)` (raises exactly
-- "update required" on a stale version -- see 0002); `public.profiles(id
-- uuid primary key, status text, ...)`; `public.cards(id text primary key,
-- tags text[], token boolean, banned boolean, catalog_version text, ...)`;
-- `public.collection(profile_id uuid, card_id text, quantity int, ...)`.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- public.loadouts — the loadout root, one row per profile.
-- ----------------------------------------------------------------------------
-- ARCHITECTURE §5.1: "A player has one loadout of exactly three decks, and
-- no card may appear in more than one of them. Because editing Deck 2 can
-- invalidate Deck 1, two individually-legal writes can produce an illegal
-- state." That is why the loadout, not the deck, is the unit of
-- persistence: this row and its `loadout_decks` / `loadout_deck_cards`
-- rows are only ever replaced together, by `app.save_loadout` below, never
-- by an independent per-deck write.
create table if not exists public.loadouts (
  profile_id      uuid primary key references public.profiles(id) on delete cascade,
  catalog_version text not null,
  updated_at      timestamptz not null default now()
);

comment on table public.loadouts is
  $$SPEC §9.4 loadout root. ARCHITECTURE §5.1: the loadout, not the deck,
  is the unit of persistence -- "editing Deck 2 can invalidate Deck 1", so
  all writes to this row and its decks/cards happen together, inside
  app.save_loadout, never through a per-table or per-deck client write.
  There is no client-writable path to this table (SPEC §9.1: "Loadout |
  Server validates and stores | Propose").$$;

comment on column public.loadouts.catalog_version is
  $$SPEC §9.4 L6's version half: "stale catalog version is rejected at
  save and queue." The catalog_version this loadout was last validated
  against; compared with app.catalog_version() via
  app.assert_catalog_version on every subsequent save and queue attempt.$$;

alter table public.loadouts enable row level security;

drop trigger if exists loadouts_set_updated_at on public.loadouts;
create trigger loadouts_set_updated_at
  before update on public.loadouts
  for each row execute function app.set_updated_at();

-- SPEC §9.1: a profile reads only its own rows. No insert/update/delete
-- policy exists for any client role -- RLS default deny is the
-- enforcement for "no client-writable path to the loadout tables"; the
-- only writer is app.save_loadout (SECURITY DEFINER, service_role only).
drop policy if exists loadouts_select_own on public.loadouts;
create policy loadouts_select_own
  on public.loadouts
  for select
  to authenticated
  using (profile_id = app.current_profile_id());

-- ----------------------------------------------------------------------------
-- public.loadout_decks — one row per deck slot (1..3) in a loadout.
-- ----------------------------------------------------------------------------
create table if not exists public.loadout_decks (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  slot       int  not null,
  name       text not null,
  primary key (profile_id, slot),
  constraint loadout_decks_slot_check check (slot between 1 and 3),
  -- So a loadout's decks cannot outlive it: deleting public.loadouts row
  -- (or, transitively, the profile) cascades to this table too, on top of
  -- the profiles(id) cascade above.
  constraint loadout_decks_loadout_fk
    foreign key (profile_id) references public.loadouts(profile_id) on delete cascade
);

comment on table public.loadout_decks is
  $$SPEC §9.4 / ARCHITECTURE §5.2. The `slot between 1 and 3` check bounds
  SPEC §9.4 L1 ("exactly 3 decks") structurally -- a slot outside 1..3
  cannot be stored -- but L1's *exactly* three (not fewer, not a partial
  set) is a save-time invariant a per-row check cannot express, so it is
  additionally checked in app.save_loadout (jsonb_array_length(p_decks) =
  3) and again in @jackioh/validator (BUILD.md M6-T3), before the call
  ever happens.$$;

comment on column public.loadout_decks.slot is
  $$SPEC §9.4 L1: the deck's position, 1..3, within the loadout.
  Positional, not client-chosen: app.save_loadout assigns it from the
  array index of the 3-element p_decks payload (index 0 -> slot 1, etc.),
  so slot is always dense and contiguous for a saved loadout.$$;

alter table public.loadout_decks enable row level security;

drop policy if exists loadout_decks_select_own on public.loadout_decks;
create policy loadout_decks_select_own
  on public.loadout_decks
  for select
  to authenticated
  using (profile_id = app.current_profile_id());

-- ----------------------------------------------------------------------------
-- public.loadout_deck_cards — the cards in one deck of a loadout.
-- ----------------------------------------------------------------------------
create table if not exists public.loadout_deck_cards (
  profile_id uuid not null,
  slot       int  not null,
  card_id    text not null references public.cards(id),
  count      int  not null,
  primary key (profile_id, slot, card_id),
  constraint loadout_deck_cards_count_check check (count > 0),
  constraint loadout_deck_cards_deck_fk
    foreign key (profile_id, slot) references public.loadout_decks(profile_id, slot)
    on delete cascade
);

comment on table public.loadout_deck_cards is
  $$SPEC §9.4: the cards in one deck of a loadout. The composite foreign
  key (profile_id, slot) -> loadout_decks(profile_id, slot) on delete
  cascade ties a card row's life to its deck row (ARCHITECTURE §5.5).$$;

comment on column public.loadout_deck_cards.count is
  $$ARCHITECTURE §5.5 schema: "count int not null check (count > 0)".
  SPEC §9.4 L3's upper bound (MAX_COPIES, currently 1) is deliberately NOT
  a check constraint here, because ARCHITECTURE §5.2 says plainly:
  "DECK_SIZE and MAX_COPIES are config. You will change them." MAX_COPIES
  is enforced by @jackioh/validator and, in this file, by app.save_loadout
  reading app.setting('max_copies').$$;

-- ----------------------------------------------------------------------------
-- SPEC §9.4 L4, quoted verbatim: "a card id appears in at most one deck,
-- also enforced by a unique index on (profile_id, card_id)."
-- ----------------------------------------------------------------------------
-- The load-bearing line of this migration. ARCHITECTURE §5.5: "That index
-- means no future migration, admin tool or import feature can violate
-- disjointness even by accident. Application validation supplies the good
-- error message; the index guarantees the property."
--
-- Deliberately on (profile_id, card_id), NOT (profile_id, slot, card_id):
-- a (profile_id, slot, card_id) index would only ever reject a duplicate
-- *within* one deck, which is already impossible -- that triple is this
-- table's primary key. The rule this index enforces is disjointness
-- *across* the three decks of one loadout, so `slot` must be excluded.
-- BUILD.md M6-T3 acceptance: "the unique index rejects a duplicate across
-- decks even when the application check is bypassed (raw SQL test)."
create unique index if not exists loadout_card_unique
  on public.loadout_deck_cards (profile_id, card_id);

comment on index public.loadout_card_unique is
  $$SPEC §9.4 L4 as a database invariant, not just application logic (see
  the -- comment immediately above the CREATE INDEX statement for the
  full quotation and rationale). Do not add `slot` to this index.$$;

alter table public.loadout_deck_cards enable row level security;

drop policy if exists loadout_deck_cards_select_own on public.loadout_deck_cards;
create policy loadout_deck_cards_select_own
  on public.loadout_deck_cards
  for select
  to authenticated
  using (profile_id = app.current_profile_id());

-- ============================================================================
-- Engine config used by app.save_loadout.
-- ============================================================================
-- BUILD.md §2 constants table: DECK_SIZE = 20 (§2.6), MAX_COPIES = 1
-- (§2.6, §9.4). Config, not schema, per ARCHITECTURE §5.2 ("You will
-- change them") -- so these live in app.settings, seeded once here, and
-- are read at save time rather than hard-coded as CHECK constraints.
insert into app.settings (key, value) values ('deck_size', to_jsonb(20))
on conflict (key) do nothing;

insert into app.settings (key, value) values ('max_copies', to_jsonb(1))
on conflict (key) do nothing;

-- ----------------------------------------------------------------------------
-- app.save_loadout — the one transactional write path for a loadout.
-- ----------------------------------------------------------------------------
-- SPEC §9.4: "Saving is `saveLoadout(profileId, catalogVersion, decks[3])`,
-- which writes all three decks in one transaction or nothing; there is no
-- per-deck save." p_decks is a 3-element JSON array, each element shaped
-- {"name": "Aggro", "cards": [{"card_id": "core-043", "count": 1}, ...]}.
--
-- This SQL is defense in depth, NOT the authority on the loadout rules.
-- SPEC §9.4 requires "one validator module shared by client and server"
-- (`packages/validator`, rules L1-L6), and ARCHITECTURE §5.6 warns: "Two
-- implementations of the same six rules will diverge, and the symptom is
-- 'it let me save this but won't let me queue'." @jackioh/validator is
-- what runs first, on both apps/web and apps/server, and supplies every
-- user-facing error message. This function exists only so that no admin
-- tool, import feature or future endpoint can persist an illegal loadout
-- even if it skips @jackioh/validator -- SPEC §9.1: "Loadout | Server
-- validates and stores | Propose". It is granted EXECUTE to service_role
-- only (see the grants below): a client proposes a loadout to the server
-- API (apps/server), and the server -- never the browser -- calls this
-- function.
create or replace function app.save_loadout(
  p_profile_id      uuid,
  p_catalog_version text,
  p_decks           jsonb
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status     text;
  v_deck_size  int;
  v_max_copies int;
  v_deck       record;
  v_deck_cards int;
  v_agg        record;
  v_owned      int;
begin
  -- SPEC §9.4: "A pending account can log in, verify its email and see
  -- the code screen, and nothing else: no collection, loadout, queue or
  -- match." Checked against p_profile_id itself, NOT via
  -- app.profile_is_active() -- that helper reads app.current_profile_id()
  -- (= auth.uid()), which has no meaning for the service_role caller that
  -- is the only role ever granted EXECUTE on this function (see the
  -- grants at the end of this file).
  select p.status into v_status from public.profiles p where p.id = p_profile_id;
  if v_status is null then
    raise exception 'loadout: profile % not found', p_profile_id;
  elsif v_status <> 'active' then
    raise exception 'loadout: profile % is not active (status=%)', p_profile_id, v_status;
  end if;

  -- L6's version half. SPEC §9.4: "stale catalog version is rejected at
  -- save and queue." Raises exactly "update required" (app.assert_
  -- catalog_version, defined in 0002).
  perform app.assert_catalog_version(p_catalog_version);

  -- Not in SPEC, and no R-row: defensive input-shape checks (p_decks must be a JSON
  -- array; each deck needs a "cards" array). @jackioh/validator is the
  -- only caller this function should ever see in practice, so p_decks is
  -- always well-formed by the time it reaches here -- but a malformed
  -- direct call should still fail with a "loadout:"-prefixed message
  -- instead of a raw jsonb-operator error, consistent with every other
  -- rejection in this function.
  if p_decks is null or jsonb_typeof(p_decks) <> 'array' then
    raise exception 'loadout: p_decks must be a JSON array of 3 decks';
  end if;

  -- L1: exactly 3 decks.
  if jsonb_array_length(p_decks) <> 3 then
    raise exception 'loadout: L1 expected exactly 3 decks, got %', jsonb_array_length(p_decks);
  end if;

  select (app.setting('deck_size'))::text::int  into v_deck_size;
  select (app.setting('max_copies'))::text::int into v_max_copies;

  -- Per-deck checks: L2 (exactly deck_size cards) and L3 (at most
  -- max_copies of a card, no Token-tagged cards). jsonb_array_elements
  -- ... with ordinality numbers each deck 1..3 by its position in
  -- p_decks -- the client never supplies a slot number.
  for v_deck in
    select t.deck, t.slot
    from jsonb_array_elements(p_decks) with ordinality as t(deck, slot)
  loop
    -- Not in SPEC, and no R-row: deck-name presence is not one of L1-L6, but
    -- loadout_decks.name is `not null`; checking it here keeps every
    -- rejection in this function nameable by the server, matching
    -- BUILD.md M6-T3's "a queue-time failure names the deck and the
    -- card" (SPEC §9.4).
    if coalesce(btrim(v_deck.deck ->> 'name'), '') = '' then
      raise exception 'loadout: deck % is missing a name', v_deck.slot;
    end if;

    if jsonb_typeof(v_deck.deck -> 'cards') is distinct from 'array' then
      raise exception 'loadout: deck % is missing a "cards" array', v_deck.slot;
    end if;

    select coalesce(sum((elem ->> 'count')::int), 0)
      into v_deck_cards
      from jsonb_array_elements(v_deck.deck -> 'cards') as elem;

    if v_deck_cards <> v_deck_size then
      raise exception 'loadout: L2 deck % has % cards, expected %',
        v_deck.slot, v_deck_cards, v_deck_size;
    end if;

    -- Group by card_id first (rather than checking each array element in
    -- isolation) so two entries for the same card_id in one deck's
    -- "cards" array are caught by their combined count, matching how the
    -- final insert below aggregates the same way.
    for v_agg in
      select (elem ->> 'card_id') as card_id, sum((elem ->> 'count')::int) as copies
      from jsonb_array_elements(v_deck.deck -> 'cards') as elem
      group by (elem ->> 'card_id')
    loop
      if v_agg.copies > v_max_copies then
        raise exception 'loadout: L3 deck % card % has % copies, max % allowed',
          v_deck.slot, v_agg.card_id, v_agg.copies, v_max_copies;
      end if;

      if exists (
        select 1 from public.cards c
        where c.id = v_agg.card_id
          and (c.token or c.tags @> array['Token']::text[])
      ) then
        raise exception 'loadout: L3 deck % card % is Token-tagged and cannot be used in a deck',
          v_deck.slot, v_agg.card_id;
      end if;
    end loop;
  end loop;

  -- Whole-loadout checks, across all 3 decks together: L6 (exists in the
  -- current catalog version, not banned) is checked before L5 (ownership)
  -- so a card that fails both gets the more informative "doesn't exist"
  -- message rather than "you own 0 copies of a card that doesn't exist".
  for v_agg in
    select (elem ->> 'card_id') as card_id, sum((elem ->> 'count')::int) as copies
    from jsonb_array_elements(p_decks) as deck,
         jsonb_array_elements(deck -> 'cards') as elem
    group by (elem ->> 'card_id')
  loop
    if not exists (
      select 1 from public.cards c
      where c.id = v_agg.card_id
        and c.catalog_version = p_catalog_version
        and c.banned = false
    ) then
      raise exception 'loadout: L6 card % is not in catalog version % or is banned',
        v_agg.card_id, p_catalog_version;
    end if;

    select coalesce(col.quantity, 0) into v_owned
      from public.collection col
      where col.profile_id = p_profile_id and col.card_id = v_agg.card_id;

    if v_agg.copies > coalesce(v_owned, 0) then
      raise exception 'loadout: L5 card % totals % copies across the loadout, only % owned',
        v_agg.card_id, v_agg.copies, coalesce(v_owned, 0);
    end if;
  end loop;

  -- Every check above passed, or this statement is never reached: an
  -- unhandled `raise exception` anywhere above aborts this whole function
  -- call, so nothing below runs and nothing already written by this call
  -- (there is none yet) survives. SPEC §9.4: "writes all three decks in
  -- one transaction or nothing; there is no per-deck save."
  --
  -- Delete before insert, in this order, so L4 (loadout_card_unique,
  -- defined with public.loadout_deck_cards above) cannot fire spuriously
  -- on a legal save that only moves a card from one deck to another
  -- within the same loadout: by the time the new rows are inserted, this
  -- profile's old loadout_deck_cards rows are already gone.
  delete from public.loadout_deck_cards where profile_id = p_profile_id;
  delete from public.loadout_decks      where profile_id = p_profile_id;
  delete from public.loadouts           where profile_id = p_profile_id;

  insert into public.loadouts (profile_id, catalog_version)
  values (p_profile_id, p_catalog_version);

  insert into public.loadout_decks (profile_id, slot, name)
  select p_profile_id, t.slot::int, (t.deck ->> 'name')
  from jsonb_array_elements(p_decks) with ordinality as t(deck, slot);

  -- L4: no pre-check here by design -- see the comment on
  -- loadout_card_unique above. If every check earlier in this function
  -- were somehow bypassed, this is where a duplicate card id across two
  -- decks of the same loadout is still caught, by the unique index
  -- raising a constraint violation. The good, rule-named error message
  -- ("you already have this card in another deck") comes from
  -- @jackioh/validator, which runs before app.save_loadout is ever
  -- called; this index is the last line of defense, not the UX.
  insert into public.loadout_deck_cards (profile_id, slot, card_id, count)
  select p_profile_id, t.slot::int, (elem ->> 'card_id'), sum((elem ->> 'count')::int)
  from jsonb_array_elements(p_decks) with ordinality as t(deck, slot),
       jsonb_array_elements(t.deck -> 'cards') as elem
  group by t.slot, (elem ->> 'card_id');
end;
$$;

comment on function app.save_loadout(uuid, text, jsonb) is
  $$SPEC §9.4's one transactional write path for a loadout: "writes all
  three decks in one transaction or nothing; there is no per-deck save."
  Checks L1-L6 (see the function body for each) and then replaces
  public.loadouts / loadout_decks / loadout_deck_cards for p_profile_id in
  full. This SQL is defense in depth, not the authority -- @jackioh/
  validator (packages/validator, ARCHITECTURE §5.6) is the shared,
  authoritative implementation of L1-L6 and supplies every user-facing
  error message; this function's raise messages are "loadout: <rule> ..."
  so calling server code can still map an unexpected failure here to a
  named rule (BUILD.md M6-T3). No client is ever granted EXECUTE on this
  function (see the grants below); the client proposes a loadout through
  the server API, and only the server, as service_role, calls this.$$;

-- ----------------------------------------------------------------------------
-- app.resolve_deck — flatten one deck to the ordered card-id list a queue
-- ticket freezes.
-- ----------------------------------------------------------------------------
-- SPEC §9.4: "Decks are frozen into the queue ticket." ARCHITECTURE §5.4:
-- "Snapshot the resolved decks into the queue ticket and carry that into
-- the match. Do not resolve from the database at match start ... [this]
-- also makes matches reproducible: log plus frozen decklist is a complete
-- record." Migration 0004 stores this function's result in
-- `tickets.frozen_deck` at enqueue time (SPEC §9.5).
--
-- A 20-card deck with MAX_COPIES = 1 resolves to 20 ids, one per card row
-- (`count` is always 1 today); `count` copies are expanded generically so
-- a future MAX_COPIES > 1 needs no change here. The result is ordered by
-- card_id so two calls against the same saved deck return the same list:
-- the engine's own shuffle (SPEC §9.3, seeded RNG) is what randomizes
-- draw order, so the frozen list itself only needs to be stable, not
-- shuffled.
create or replace function app.resolve_deck(p_profile_id uuid, p_slot int)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  -- Not in SPEC, and no R-row: raising when the slot is empty, rather than returning
  -- `[]`. SPEC doesn't describe this failure mode, but silently freezing
  -- an empty deck into a queue ticket would be a worse failure than an
  -- exception the caller (the enqueue endpoint, 0004) can catch and map
  -- to "you don't have a deck in that slot".
  if not exists (
    select 1 from public.loadout_decks ld
    where ld.profile_id = p_profile_id and ld.slot = p_slot
  ) then
    raise exception 'loadout: no deck in slot % for profile %', p_slot, p_profile_id;
  end if;

  select coalesce(jsonb_agg(x.card_id order by x.card_id), '[]'::jsonb)
    into v_result
    from (
      select ldc.card_id
      from public.loadout_deck_cards ldc, generate_series(1, ldc.count)
      where ldc.profile_id = p_profile_id and ldc.slot = p_slot
    ) as x;

  return v_result;
end;
$$;

comment on function app.resolve_deck(uuid, int) is
  $$SPEC §9.4 "Decks are frozen into the queue ticket"; ARCHITECTURE §5.4.
  Expands loadout_deck_cards.count copies of each card_id for one
  (profile_id, slot) into a flat jsonb array of card ids, ordered by
  card_id for a stable, reproducible result. Migration 0004 stores this
  in tickets.frozen_deck at enqueue time. Called only by trusted server
  code running as service_role (see the grants below), never by a client
  directly -- resolving happens once, at enqueue, per ARCHITECTURE §5.4's
  "do not resolve from the database at match start".$$;

-- ============================================================================
-- Explicit grants (default-deny first: revoke everything, then grant back
-- only what SPEC §9.1/§9.4/§9.8 allow).
-- ============================================================================
revoke all on public.loadouts           from public, anon, authenticated;
revoke all on public.loadout_decks      from public, anon, authenticated;
revoke all on public.loadout_deck_cards from public, anon, authenticated;

grant select on public.loadouts           to authenticated;
grant select on public.loadout_decks      to authenticated;
grant select on public.loadout_deck_cards to authenticated;

revoke all on function app.save_loadout(uuid, text, jsonb) from public;
revoke all on function app.resolve_deck(uuid, int)          from public;

grant execute on function app.save_loadout(uuid, text, jsonb) to service_role;
grant execute on function app.resolve_deck(uuid, int)          to service_role;

-- ----------------------------------------------------------------------------
-- Closing summary of what this schema lets each role do.
-- ----------------------------------------------------------------------------
-- anon:          nothing on loadouts, loadout_decks or loadout_deck_cards.
-- authenticated: SELECT on all three tables, filtered by RLS to rows
--                where profile_id = app.current_profile_id() (its own
--                loadout only). No INSERT, UPDATE or DELETE grant or
--                policy exists for authenticated on any of the three
--                tables, and no EXECUTE grant exists for authenticated on
--                app.save_loadout or app.resolve_deck -- there is no
--                client-writable path to the loadout tables (SPEC §9.1:
--                "Loadout | Server validates and stores | Propose"; SPEC
--                §9.4). A client reads its own loadout with a plain
--                SELECT and proposes a whole new one to the server API
--                (apps/server), which validates it with
--                @jackioh/validator and only then calls app.save_loadout.
-- service_role:  BYPASSRLS covers reads/writes to all three tables
--                directly; app.save_loadout and app.resolve_deck are
--                additionally granted EXECUTE explicitly so the API and
--                matchmaking server can call them. Even service_role gets
--                no shortcut around L1-L6: app.save_loadout enforces them
--                regardless of caller.
-- Every mutation of a loadout is reachable only through app.save_loadout
-- (all six rules, all-or-nothing); the only reader of a resolved,
-- queue-ready deck is app.resolve_deck -- never through a client request.
-- ============================================================================
