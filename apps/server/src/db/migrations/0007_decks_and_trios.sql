-- ============================================================================
-- Migration 0007: Saved decks and trios
-- ============================================================================
-- Serves SPEC.md §9.4 ("Decks and trios") and SPEC §11 R250-R256, quoted:
--   "A player saves up to `MAX_SAVED_DECKS` (10) named decks and builds up
--   to `MAX_SAVED_TRIOS` (5) trios from them; a trio is three of the
--   player's saved decks, in order (R250, R252). Both are drafts, so a save
--   checks structure and never legality ... Every deck and trio has an id
--   the client mints, and saving one is an idempotent upsert of it alone
--   (R256); deleting a deck empties the trio slots that held it ... The
--   single loadout of three decks that came before became three saved decks
--   and one trio (R254)."
-- and SPEC §9.1 (Trust model): "Loadout | Server validates and stores |
-- Propose" -- which is still true of a deck and of a trio: the browser
-- proposes one to the server API and never writes a row here.
--
-- What changed from 0003, and why the shape changed with it. 0003 stored ONE
-- loadout per profile, three decks saved all-or-nothing, and made SPEC §9.4
-- L4 ("a card id appears in at most one deck") a database invariant with the
-- loadout_card_unique index. R250 turns a deck into a draft saved on its own,
-- and R252 lets one deck sit in several trios and lets a saved trio share
-- cards (it is judged at queue, R253), so there is no longer any set of rows
-- over which a unique index could state L4: it became a property of a trio at
-- the moment it is queued, which @jackioh/validator checks. What a deck does
-- need from the database is its cards in the order the player put them
-- (the Store port's `SavedDeck.cards`), which 0003's (profile, slot, card,
-- count) rows could not keep without a position column and one jsonb array
-- keeps for free. Hence `decks.cards jsonb`.
--
-- R254: 0003's three tables stay exactly where they are. The data migration
-- at the end of this file copies every loadout into three decks and one trio;
-- from here on nothing reads or writes public.loadouts, public.loadout_decks
-- or public.loadout_deck_cards, so nothing a player saved is lost and a
-- server rolled back to before this migration finds its rows untouched.
--
-- Apply order: 0001 (schema `app`, `app.settings`/`app.setting`,
-- `app.current_profile_id`, `public.profiles`) -> 0002 -> 0003
-- (`public.loadouts` and friends, `app.resolve_deck`, which R254 reads) ->
-- 0004 -> 0005 -> 0006 -> 0007 (this file) -> 0008 (queue modes) -> 0009
-- (the Best-of-3 series).
--
-- This file only ADDS objects and never redefines anything from 0001-0006.
-- Like 0001-0004 it is safe to re-apply: create-if-not-exists,
-- drop-if-exists-then-create, and a data migration that skips every profile
-- it has already converted.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- public.decks -- one row per saved deck (SPEC §9.4, R250).
-- ----------------------------------------------------------------------------
-- No default on `id`: R256 has the client mint it (`crypto.randomUUID()`), so
-- that a retried save of the same edit lands on the same row instead of
-- making a second deck. Every writer names the id it means.
--
-- No app.set_updated_at() trigger either, unlike 0003's loadouts:
-- `updated_at` is the save instant the server hands back to the builder as
-- the deck's `updatedAt` (R256's "Saved"), so the server stamps it, and a
-- trigger overwriting it with the database's clock would make the two
-- disagree.
create table if not exists public.decks (
  id              uuid primary key,
  profile_id      uuid not null references public.profiles(id) on delete cascade,
  name            text not null,
  cards           jsonb not null default '[]'::jsonb,
  catalog_version text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint decks_cards_is_array_check check (jsonb_typeof(cards) = 'array'),
  -- The target of public.trios' composite foreign keys below: a trio slot may
  -- name only a deck of the SAME profile (R252 "naming the profile's own
  -- saved decks"), and a foreign key can say so only against a key that
  -- carries profile_id too. `id` alone is already unique; this is that
  -- uniqueness restated in the shape the foreign keys need.
  constraint decks_profile_id_id_key unique (profile_id, id)
);

comment on table public.decks is
  $$SPEC §9.4 / R250: a profile's saved decks, each a DRAFT -- a save checks
  structure only (D1 name, D2 at most DECK_SIZE cards, D3 deckable cards, D4
  at most MAX_COPIES of a card) and never legality: an incomplete deck, an
  unowned card and a banned card are all kept and judged when the deck is
  queued (R253). Written only by app.upsert_deck (SECURITY DEFINER,
  service_role only) and deleted only by the server; there is no client
  write path (SPEC §9.1: "Server validates and stores | Propose").$$;

comment on column public.decks.id is
  $$R256: minted by the client, so saving a deck is an idempotent upsert that
  a dropped connection can retry without making a second deck.$$;

comment on column public.decks.name is
  $$R250 D1: 1 to deck_name_max_length characters once trimmed, with no
  control characters, stored as @jackioh/validator's normalizeName leaves it.$$;

comment on column public.decks.cards is
  $$R250 / R251: the deck's catalog ids, in the order the player put them in,
  as a jsonb array of strings. A card is its catalog id (R251): Radiant is a
  flag on a card in play, never an entry here. At most deck_size entries (D2)
  and at most max_copies of one id (D4), both re-checked by app.upsert_deck.$$;

comment on column public.decks.catalog_version is
  $$R253: the catalog version the client held at the last save. Informational
  only -- "a saved deck's own version is no reason to refuse it, because the
  queue checks its cards against the current catalog (L6)".$$;

comment on column public.decks.created_at is
  $$The list order. SPEC §11 R257's legacy `deckIndex` names a deck by its
  place in the saved list, oldest first, so a profile's decks are read
  ordered by (created_at, id) everywhere.$$;

-- The one read path: "a profile's decks, oldest first" (R257's deckIndex
-- order), which this index answers in order without a sort.
create index if not exists decks_profile_created_idx
  on public.decks (profile_id, created_at, id);

alter table public.decks enable row level security;

-- SPEC §9.1: a profile reads only its own rows, exactly as 0003's loadout
-- tables. No insert/update/delete policy exists for any client role: RLS
-- default deny is the enforcement for "no client-writable path", and the
-- only writer is the server.
drop policy if exists decks_select_own on public.decks;
create policy decks_select_own
  on public.decks
  for select
  to authenticated
  using (profile_id = app.current_profile_id());

-- ----------------------------------------------------------------------------
-- public.trios -- one row per saved trio (SPEC §9.4, R252).
-- ----------------------------------------------------------------------------
-- Three ordered slots, each naming one of the profile's decks or empty. The
-- slots are columns rather than rows because a trio is ALWAYS exactly three
-- (R252 T2) and its order is its meaning (R259: a series' third game is
-- picked "in trio order", and R260's timeout picks the first unplayed slot).
create table if not exists public.trios (
  id         uuid primary key,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  name       text not null,
  deck1_id   uuid,
  deck2_id   uuid,
  deck3_id   uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- R252: "each three ordered slots naming the profile's own saved decks".
  -- Composite, so a slot cannot name another profile's deck even by a raw
  -- write, and `on delete set null (deckN_id)` (the column-list form, Postgres
  -- 15+, which Supabase runs) so that "deleting a deck empties every slot that
  -- named it and keeps the trio" is the database's own behaviour: the slot
  -- goes empty while profile_id -- also a column of the key -- is left alone.
  -- MATCH SIMPLE (the default) leaves an empty slot unchecked, which is what
  -- makes an empty slot legal.
  constraint trios_deck1_fk foreign key (profile_id, deck1_id)
    references public.decks (profile_id, id) on delete set null (deck1_id),
  constraint trios_deck2_fk foreign key (profile_id, deck2_id)
    references public.decks (profile_id, id) on delete set null (deck2_id),
  constraint trios_deck3_fk foreign key (profile_id, deck3_id)
    references public.decks (profile_id, id) on delete set null (deck3_id),
  -- R252 T3: "no deck twice". Each comparison is NULL when either slot is
  -- empty, and a CHECK passes on NULL, so empty slots never collide with
  -- anything while two filled slots naming one deck make the whole
  -- conjunction false.
  constraint trios_decks_distinct check (
    deck1_id <> deck2_id and deck1_id <> deck3_id and deck2_id <> deck3_id
  )
);

comment on table public.trios is
  $$SPEC §9.4 / R252: a profile's saved trios -- three ordered slots, each one
  of the profile's own decks or empty. A DRAFT like a deck: decks that share
  cards may be saved together, and whether a trio may be played is judged at
  queue (R253, L1-L6). Written only by app.upsert_trio (SECURITY DEFINER,
  service_role only); no client write path (SPEC §9.1).$$;

comment on column public.trios.deck1_id is
  $$R252: slot 1, or NULL for an empty slot. trios_deck1_fk ties it to a deck
  of the same profile and empties it when that deck is deleted.$$;

-- Lists (oldest first, as decks) and, through its leading profile_id, the
-- lookups the three foreign keys make when a deck is deleted: a profile holds
-- at most max_saved_trios rows, so filtering by profile leaves a handful to
-- check against deckN_id and three more indexes would buy nothing.
create index if not exists trios_profile_created_idx
  on public.trios (profile_id, created_at, id);

alter table public.trios enable row level security;

drop policy if exists trios_select_own on public.trios;
create policy trios_select_own
  on public.trios
  for select
  to authenticated
  using (profile_id = app.current_profile_id());

-- ============================================================================
-- Server config the two upserts read.
-- ============================================================================
-- These three MIRROR apps/server/src/config.ts -- MAX_SAVED_DECKS (10),
-- MAX_SAVED_TRIOS (5) and DECK_NAME_MAX_LENGTH (40), SPEC §11 R250 and R252
-- -- which is where the server and the deck builder read them. They are
-- repeated here, as 0003 repeated deck_size and max_copies, so that the
-- database refuses a deck past the cap or a name past the limit even from a
-- caller that skipped the server's checks; the server passes its own cap to
-- each upsert and the function applies the smaller of the two. Changing one
-- of these numbers for a deployment means config.ts AND a new migration
-- updating the row here.
insert into app.settings (key, value) values ('max_saved_decks', to_jsonb(10))
on conflict (key) do nothing;

insert into app.settings (key, value) values ('max_saved_trios', to_jsonb(5))
on conflict (key) do nothing;

insert into app.settings (key, value) values ('deck_name_max_length', to_jsonb(40))
on conflict (key) do nothing;

-- ----------------------------------------------------------------------------
-- app.upsert_deck -- the one write path for a saved deck (R250, R256).
-- ----------------------------------------------------------------------------
-- R256: "saving one is an idempotent upsert of it alone that can be retried
-- after a dropped connection without making a second". Inserts a deck whose
-- id is new, or replaces the name, cards, version and updated_at of the
-- profile's own deck (created_at is kept, so the list order is stable).
-- Returns what it did, as the Store port's `UpsertOutcome`:
--   'created' / 'updated' -- written;
--   'limit'     -- a create would take the profile past its cap (R250);
--                  nothing written;
--   'not_owner' -- the id is another profile's deck; nothing written, and the
--                  server answers exactly as for a missing id, so an id
--                  reveals nothing about anyone else.
--
-- The cap is counted under a lock on the profile row (`select ... for
-- update`), so two concurrent creates for one profile run one after the other
-- and cannot both see nine decks and both write a tenth. A retried save of
-- the same new id takes the same lock and finds the first write: 'updated'.
--
-- p_at is the save instant: created_at (on insert) and updated_at (always).
-- p_max_decks is the caller's cap (MAX_SAVED_DECKS, via the Store port's
-- `maxDecks`); the function applies least(p_max_decks, max_saved_decks).
--
-- Like 0003's app.save_loadout this is defense in depth, NOT the authority:
-- @jackioh/validator's checkDeckDraft (D1-D4) runs on the server first and
-- supplies every message a player reads. The shape checks below exist so that
-- no admin tool or future endpoint can store a deck the rules could not have
-- produced; each raises with a "deck:" prefix, which no player ever sees.
-- D3 (every card a deckable catalog card) is deliberately NOT re-checked here:
-- a deck is a draft that outlives catalog versions, and public.cards is
-- seeded per deployment, so a database copy that lagged the server's catalog
-- would refuse saves the server rightly accepts. L6 at queue time is where a
-- card's existence is judged (R253).
create or replace function app.upsert_deck(
  p_profile_id      uuid,
  p_deck_id         uuid,
  p_name            text,
  p_cards           jsonb,
  p_catalog_version text,
  p_at              timestamptz,
  p_max_decks       int
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status     text;
  v_owner      uuid;
  v_name_max   int;
  v_deck_size  int;
  v_max_copies int;
  v_cap        int;
  v_count      int;
  v_written    uuid;
begin
  -- SPEC §9.4: a pending account has "no collection, loadout, queue or
  -- match", and a saved deck is the loadout's successor. Checked against
  -- p_profile_id itself, as app.save_loadout does, because the only caller is
  -- service_role, for whom app.profile_is_active() (auth.uid()) means nothing.
  -- `for update` is the lock the cap below is counted under.
  select p.status into v_status
    from public.profiles p
   where p.id = p_profile_id
     for update;
  if not found then
    raise exception 'deck: profile % not found', p_profile_id;
  elsif v_status <> 'active' then
    raise exception 'deck: profile % is not active (status=%)', p_profile_id, v_status;
  end if;

  -- R250 D1, defensively: a name, not too long, no control characters.
  -- char_length counts code points, which is what the validator counts.
  select (app.setting('deck_name_max_length'))::text::int into v_name_max;
  if p_name is null or btrim(p_name) = '' then
    raise exception 'deck: a deck needs a name';
  end if;
  if char_length(p_name) > v_name_max then
    raise exception 'deck: the name is % characters, at most % allowed',
      char_length(p_name), v_name_max;
  end if;
  if p_name ~ '[[:cntrl:]]' then
    raise exception 'deck: the name contains a control character';
  end if;

  -- R250 D2 and D4, defensively, plus the shape the Store port reads back: a
  -- jsonb array of card-id strings.
  if p_cards is null or jsonb_typeof(p_cards) <> 'array' then
    raise exception 'deck: p_cards must be a JSON array of card ids';
  end if;
  if exists (select 1 from jsonb_array_elements(p_cards) as e(card) where jsonb_typeof(e.card) <> 'string') then
    raise exception 'deck: every entry of p_cards must be a card id string';
  end if;
  select (app.setting('deck_size'))::text::int  into v_deck_size;
  select (app.setting('max_copies'))::text::int into v_max_copies;
  if jsonb_array_length(p_cards) > v_deck_size then
    raise exception 'deck: D2 % cards, at most % allowed', jsonb_array_length(p_cards), v_deck_size;
  end if;
  if exists (
    select 1 from jsonb_array_elements_text(p_cards) as c(card_id)
     group by c.card_id having count(*) > v_max_copies
  ) then
    raise exception 'deck: D4 a card appears more than % time(s)', v_max_copies;
  end if;

  -- R256: an existing id is updated in place -- but only the owner's. The row
  -- lock holds off a concurrent delete of it until this save commits.
  select d.profile_id into v_owner from public.decks d where d.id = p_deck_id for update;
  if found then
    if v_owner <> p_profile_id then
      return 'not_owner';
    end if;
    update public.decks
       set name = p_name,
           cards = p_cards,
           catalog_version = p_catalog_version,
           updated_at = p_at
     where id = p_deck_id;
    return 'updated';
  end if;

  -- R250: a create past the cap writes nothing.
  v_cap := least(p_max_decks, (app.setting('max_saved_decks'))::text::int);
  select count(*) into v_count from public.decks d where d.profile_id = p_profile_id;
  if v_count >= v_cap then
    return 'limit';
  end if;

  -- The profile lock serialises this profile's writers, not another
  -- profile's: a different profile inserting the same brand-new id at the
  -- same instant is the one race left, and whoever lost it is by definition
  -- not the owner of the row that won.
  insert into public.decks (id, profile_id, name, cards, catalog_version, created_at, updated_at)
  values (p_deck_id, p_profile_id, p_name, p_cards, p_catalog_version, p_at, p_at)
  on conflict (id) do nothing
  returning id into v_written;
  if v_written is null then
    return 'not_owner';
  end if;
  return 'created';
end;
$$;

comment on function app.upsert_deck(uuid, uuid, text, jsonb, text, timestamptz, int) is
  $$R250 / R256: the one write path for a saved deck. Creates the deck or
  updates the profile's own (created_at kept), returning 'created',
  'updated', 'limit' (past least(p_max_decks, app.settings max_saved_decks);
  nothing written) or 'not_owner' (another profile's id; nothing written).
  The cap is counted under the profile row lock. Shape checks (D1, D2, D4,
  an active profile) raise with a "deck:" prefix; @jackioh/validator is the
  authority and runs first. service_role only.$$;

-- ----------------------------------------------------------------------------
-- app.upsert_trio -- the one write path for a saved trio (R252, R256).
-- ----------------------------------------------------------------------------
-- As app.upsert_deck, plus one outcome: 'unknown_deck' when a filled slot
-- names a deck that is not one of this profile's (another profile's, or none
-- at all). R252 T3 (no deck twice) is not an outcome but the
-- trios_decks_distinct constraint, which raises: @jackioh/validator's
-- checkTrioDraft refuses it first, so reaching the constraint is a bug in the
-- caller, not a player's mistake.
--
-- The foreign keys would refuse an unknown deck too; the explicit check comes
-- first so the answer is an outcome the server maps to its 409 rather than an
-- exception, and the handler below maps the one race the check cannot see (the
-- deck deleted between the check and the write) onto the same answer.
create or replace function app.upsert_trio(
  p_profile_id uuid,
  p_trio_id    uuid,
  p_name       text,
  p_deck1_id   uuid,
  p_deck2_id   uuid,
  p_deck3_id   uuid,
  p_at         timestamptz,
  p_max_trios  int
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status   text;
  v_owner    uuid;
  v_name_max int;
  v_cap      int;
  v_count    int;
  v_written  uuid;
begin
  -- Same gate and same lock as app.upsert_deck (see there).
  select p.status into v_status
    from public.profiles p
   where p.id = p_profile_id
     for update;
  if not found then
    raise exception 'trio: profile % not found', p_profile_id;
  elsif v_status <> 'active' then
    raise exception 'trio: profile % is not active (status=%)', p_profile_id, v_status;
  end if;

  -- R252 T1 is "a name as D1".
  select (app.setting('deck_name_max_length'))::text::int into v_name_max;
  if p_name is null or btrim(p_name) = '' then
    raise exception 'trio: a trio needs a name';
  end if;
  if char_length(p_name) > v_name_max then
    raise exception 'trio: the name is % characters, at most % allowed',
      char_length(p_name), v_name_max;
  end if;
  if p_name ~ '[[:cntrl:]]' then
    raise exception 'trio: the name contains a control character';
  end if;

  select t.profile_id into v_owner from public.trios t where t.id = p_trio_id for update;
  if found and v_owner <> p_profile_id then
    return 'not_owner';
  end if;

  -- R252: "naming the profile's own saved decks".
  if exists (
    select 1
      from unnest(array[p_deck1_id, p_deck2_id, p_deck3_id]) as s(deck_id)
     where s.deck_id is not null
       and not exists (
         select 1 from public.decks d
          where d.id = s.deck_id and d.profile_id = p_profile_id
       )
  ) then
    return 'unknown_deck';
  end if;

  begin
    if v_owner is not null then
      update public.trios
         set name = p_name,
             deck1_id = p_deck1_id,
             deck2_id = p_deck2_id,
             deck3_id = p_deck3_id,
             updated_at = p_at
       where id = p_trio_id;
      return 'updated';
    end if;

    -- R252: a create past the cap writes nothing.
    v_cap := least(p_max_trios, (app.setting('max_saved_trios'))::text::int);
    select count(*) into v_count from public.trios t where t.profile_id = p_profile_id;
    if v_count >= v_cap then
      return 'limit';
    end if;

    insert into public.trios (
      id, profile_id, name, deck1_id, deck2_id, deck3_id, created_at, updated_at
    ) values (
      p_trio_id, p_profile_id, p_name, p_deck1_id, p_deck2_id, p_deck3_id, p_at, p_at
    )
    on conflict (id) do nothing
    returning id into v_written;
    if v_written is null then
      return 'not_owner';
    end if;
    return 'created';
  exception
    when foreign_key_violation then
      -- A slot's deck was deleted after the check above and before the write.
      return 'unknown_deck';
  end;
end;
$$;

comment on function app.upsert_trio(uuid, uuid, text, uuid, uuid, uuid, timestamptz, int) is
  $$R252 / R256: the one write path for a saved trio. Creates the trio or
  updates the profile's own, returning 'created', 'updated', 'limit' (past
  least(p_max_trios, app.settings max_saved_trios)), 'not_owner' (another
  profile's id) or 'unknown_deck' (a filled slot that is not one of this
  profile's decks); nothing is written unless the answer is created/updated.
  A deck in two slots raises trios_decks_distinct (T3). The cap is counted
  under the profile row lock. service_role only.$$;

-- ============================================================================
-- R254: every loadout becomes three decks and one trio.
-- ============================================================================
-- SPEC §11 R254: "Migration 0007 turns every saved loadout into three saved
-- decks, named and filled as its three decks were, plus one trio named "My
-- trio" holding them in their slot order. The loadout tables stay where they
-- are, no longer read or written, so nothing a player saved is lost."
--
--   * cards: app.resolve_deck(profile, slot) -- 0003's own reader, the list a
--     queue ticket froze from that slot, so a converted deck holds exactly
--     what the player last queued with (ordered by card id, which is the only
--     order a loadout ever had);
--   * name: loadout_decks.name as @jackioh/validator's normalizeName would
--     leave it (trimmed, inner whitespace collapsed), without the control and
--     invisible format characters D1 refuses, and cut to deck_name_max_length
--     (trimmed again after the cut), falling back to "Deck <slot>" if nothing
--     is left, so every converted deck passes R250 D1 and can be saved again
--     as it is;
--   * catalog_version: the loadout's, the version its decks were last
--     validated against (R253: informational);
--   * created_at: loadouts.updated_at plus <slot> milliseconds, so the saved
--     list -- ordered by (created_at, id) -- reads Deck 1, 2, 3 in slot order
--     and R257's legacy `deckIndex` 0..2 names the slot it always named;
--   * ids: gen_random_uuid(). R256 has the client mint ids for what it saves;
--     these were saved before there was a client-minted id to keep.
--
-- Idempotent: a profile that already holds a deck or a trio is skipped, so
-- re-applying this file converts nothing twice (and never touches a profile
-- that has started saving decks of its own). A loadout with fewer than three
-- deck rows -- 0003's app.save_loadout never wrote one, but a raw write could
-- have -- converts what it has and leaves the rest of the trio's slots empty,
-- which R252 allows.
do $$
declare
  v_loadout  record;
  v_deck     record;
  v_ids      uuid[];
  v_id       uuid;
  v_name     text;
  v_name_max int := (app.setting('deck_name_max_length'))::text::int;
  -- What @jackioh/validator's D1 calls a control character, as far as a converted name can hold
  -- one: the C0/C1 controls, and the invisible format characters -- soft hyphen, the
  -- bidirectional marks, embeddings, overrides and isolates, the zero-width space, word joiner and
  -- invisible operators, the byte-order mark. The joiners emoji are written with stay.
  v_refused  text := '[[:cntrl:]\u00AD\u061C\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]';
begin
  for v_loadout in
    select l.profile_id, l.catalog_version, l.updated_at
      from public.loadouts l
     where not exists (select 1 from public.decks d where d.profile_id = l.profile_id)
       and not exists (select 1 from public.trios t where t.profile_id = l.profile_id)
     order by l.profile_id
  loop
    v_ids := array[null, null, null]::uuid[];

    for v_deck in
      select ld.slot, ld.name
        from public.loadout_decks ld
       where ld.profile_id = v_loadout.profile_id
       order by ld.slot
    loop
      -- Whitespace first (a tab or a newline is a space to normalizeName), then the characters D1
      -- refuses, then whitespace again, and the trim after the cut too: a cut that ends on a space
      -- would leave one.
      v_name := btrim(left(btrim(regexp_replace(
        regexp_replace(regexp_replace(v_deck.name, '\s+', ' ', 'g'), v_refused, '', 'g'),
        '\s+', ' ', 'g')), v_name_max));
      if v_name = '' then
        v_name := 'Deck ' || v_deck.slot;
      end if;
      v_id := gen_random_uuid();

      insert into public.decks (id, profile_id, name, cards, catalog_version, created_at, updated_at)
      values (
        v_id,
        v_loadout.profile_id,
        v_name,
        app.resolve_deck(v_loadout.profile_id, v_deck.slot),
        v_loadout.catalog_version,
        v_loadout.updated_at + v_deck.slot * interval '1 millisecond',
        v_loadout.updated_at + v_deck.slot * interval '1 millisecond'
      );
      v_ids[v_deck.slot] := v_id;
    end loop;

    insert into public.trios (id, profile_id, name, deck1_id, deck2_id, deck3_id, created_at, updated_at)
    values (
      gen_random_uuid(), v_loadout.profile_id, 'My trio', v_ids[1], v_ids[2], v_ids[3],
      v_loadout.updated_at, v_loadout.updated_at
    );
  end loop;
end $$;

-- ============================================================================
-- Explicit grants (default-deny first: revoke everything, then grant back
-- only what SPEC §9.1/§9.4 allow), exactly as 0003 did for the loadout.
-- ============================================================================
revoke all on public.decks from public, anon, authenticated;
revoke all on public.trios from public, anon, authenticated;

grant select on public.decks to authenticated;
grant select on public.trios to authenticated;

revoke all on function app.upsert_deck(uuid, uuid, text, jsonb, text, timestamptz, int)       from public;
revoke all on function app.upsert_trio(uuid, uuid, text, uuid, uuid, uuid, timestamptz, int) from public;

grant execute on function app.upsert_deck(uuid, uuid, text, jsonb, text, timestamptz, int)       to service_role;
grant execute on function app.upsert_trio(uuid, uuid, text, uuid, uuid, uuid, timestamptz, int) to service_role;

-- ----------------------------------------------------------------------------
-- Closing summary of what this schema lets each role do.
-- ----------------------------------------------------------------------------
-- anon:          nothing on decks or trios, and no EXECUTE on either upsert.
-- authenticated: SELECT on both tables, filtered by RLS to rows where
--                profile_id = app.current_profile_id() -- its own decks and
--                trios only. No INSERT, UPDATE or DELETE grant or policy on
--                either table and no EXECUTE on app.upsert_deck or
--                app.upsert_trio: a client proposes a deck or a trio to the
--                server API (SPEC §9.1 "Server validates and stores |
--                Propose"), which checks it with @jackioh/validator and only
--                then calls these functions.
-- service_role:  BYPASSRLS covers reads/writes to both tables directly (a
--                delete is a plain `delete`, and the trio slots empty
--                themselves through the foreign keys); app.upsert_deck and
--                app.upsert_trio are additionally granted EXECUTE explicitly,
--                and every save goes through them.
-- ============================================================================
