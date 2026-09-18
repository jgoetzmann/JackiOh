-- ============================================================================
-- Migration 0002: Collection ledger
-- ============================================================================
-- Serves SPEC §9.4 (Accounts, collection, loadouts):
--   "Collection is an entitlement ledger (`collection` plus append-only
--   `collection_grants`); catalog is static, versioned, shipped with the
--   client; stale catalog version is rejected at save and queue. Every
--   collection change writes `collection` and `collection_grants` in one
--   transaction, and no client path writes either."
-- and SPEC §9.1 (Trust model): "Everyone owns every card at launch; keep
-- the ledger anyway" and SPEC §9.8 (Abuse surface): "Claiming unowned
-- cards | The collection is server-owned; loadouts are validated against
-- it (9.4)". See also ARCHITECTURE-CCG.md §4 "Collection".
--
-- Apply order: 0001 (schema `app`, `app.settings`/`app.setting`,
-- `app.catalog_version`, `app.current_profile_id`, `app.profile_is_active`,
-- `app.deny_row_mutation`, `app.set_updated_at`, `public.profiles`) ->
-- 0002 (this file: `public.cards`, `public.collection`,
-- `public.collection_grants`, the launch-mode grant path,
-- `app.assert_catalog_version`) -> 0003 -> 0004.
--
-- This file only ADDS objects. It never redefines anything 0001 already
-- created, and 0003/0004 reference `public.cards(id)`, so `id` is
-- `text primary key` per the shared schema contract.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- public.cards — the static catalog projection.
-- ----------------------------------------------------------------------------
-- How this table is loaded (informational; the loader itself is not part
-- of this migration): the server seeds it from `packages/cards/catalog.json`
-- at bring-up (a loader in `apps/server`), stamping `catalog_version` on
-- every row it writes for that catalog build. This table is NOT the
-- client's source of card text or art — SPEC §9.4: "catalog is static,
-- versioned, shipped with the client" — it exists so `collection` and
-- `collection_grants` have something to reference with a real foreign key,
-- and so the server can run the SPEC §9.4 L6 check ("every card exists in
-- the current catalog version and is not banned") without trusting the
-- client's copy of the catalog.
create table if not exists public.cards (
  id              text primary key,               -- e.g. 'core-043' (BUILD M4-T1)
  card_index      text not null,                   -- SPEC §5.1 "Index"; see comment below
  name            text not null,
  set_id          text not null,                   -- SPEC §5.1 "Set" (Core now; more reserved)
  type            text not null,
  tags            text[] not null default '{}',
  rarity          text not null,
  token           boolean not null default false,
  cost            jsonb not null,                  -- number | "X" | {base, embiggen} (BUILD M4-T1)
  banned          boolean not null default false,
  catalog_version text not null,
  created_at      timestamptz not null default now(),
  constraint cards_type_check check (
    -- SPEC §5.1 Types: "Unit, Spell, Field Spell, Trap, Field Trap"
    type in ('Unit', 'Spell', 'Field Spell', 'Trap', 'Field Trap')
  ),
  constraint cards_rarity_check check (
    -- SPEC §5.1: "Common, Rare, Epic, Legendary, Mythic; Token for every
    -- token" (SPEC §8 confirms the same five real rarities plus Token).
    rarity in ('Common', 'Rare', 'Epic', 'Legendary', 'Mythic', 'Token')
  ),
  constraint cards_tags_check check (
    -- BUILD M4-T1 acceptance: "Every tags value is one of Human, Felinor,
    -- KY, CN, Fruit, 'Call to Chaos', Quickdraw, Token."
    tags <@ array[
      'Human', 'Felinor', 'KY', 'CN', 'Fruit', 'Call to Chaos', 'Quickdraw', 'Token'
    ]::text[]
  )
);

comment on table public.cards is
  $$SPEC §9.4: catalog is static, versioned, shipped with the client. This
  table exists for referential integrity (collection / collection_grants
  foreign keys) and for the server-side L6 check ("every card exists in the
  current catalog version and is not banned", SPEC §9.4) -- it is not the
  client's source of card text, art or rules wording.$$;

comment on column public.cards.card_index is
  $$SPEC §5.1 "Index": 1-100 for real cards; tokens use "N.1" (e.g. '51.1')
  when card N defines them, or "T-name" for shared tokens (Rush, Sheep,
  Felinor, Bread) per BUILD M4-T1. Named card_index rather than index
  because index is a reserved-adjacent SQL keyword.$$;

comment on column public.cards.set_id is
  $$SPEC §5.1 "Set": Core for launch; Classic, Boss, Boss-X reserved for
  later sets. No check constraint yet since only Core ships (SPEC §5.3).$$;

comment on column public.cards.cost is
  $$BUILD M4-T1 cost union: number | "X" | {base, embiggen}. Stored as
  jsonb so this column matches catalog.json's cost field verbatim.$$;

comment on column public.cards.token is
  $$SPEC §5.1: "Token: generated only when a card names it." Token rows
  are excluded from app.grant_launch_collection (SPEC §9.4 loadouts L3:
  "no Token-tagged cards") and from random pools (catalog.query).$$;

comment on column public.cards.banned is
  $$SPEC §9.4 loadout rule L6: "every card exists in the current catalog
  version and is not banned." Read by the server-side loadout validator.$$;

comment on column public.cards.catalog_version is
  $$SPEC §9.4: "stale catalog version is rejected at save and queue."
  Compared against app.catalog_version() by app.assert_catalog_version.$$;

create index if not exists cards_catalog_version_idx
  on public.cards (catalog_version);

-- Partial index: fast lookup of banned cards within a catalog version,
-- for the SPEC §9.4 L6 check ("... and is not banned").
create index if not exists cards_banned_idx
  on public.cards (catalog_version)
  where banned;

alter table public.cards enable row level security;

-- SPEC §9.4: the catalog is read-only projection data. authenticated may
-- read it (the deck builder and server both need it); anon gets nothing,
-- matching the trust model's "Identity and entitlement | Server | Read a
-- projection" row (SPEC §9.1). No insert/update/delete policy exists for
-- any client role, so writes fall through to the RLS default deny.
drop policy if exists cards_select_authenticated on public.cards;
create policy cards_select_authenticated
  on public.cards
  for select
  to authenticated
  using (true);

-- ----------------------------------------------------------------------------
-- public.collection — the entitlement ledger's current-quantity projection.
-- ----------------------------------------------------------------------------
-- SPEC §9.4: "Collection is an entitlement ledger (`collection` plus
-- append-only `collection_grants`) ... no client path writes either."
create table if not exists public.collection (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  card_id    text not null references public.cards(id),
  quantity   int  not null default 0 check (quantity >= 0),
  updated_at timestamptz not null default now(),
  primary key (profile_id, card_id)
);

comment on table public.collection is
  $$SPEC §9.4: entitlement ledger's current-quantity view, server-owned.
  "no client path writes either [collection or collection_grants]" -- there
  is no insert/update/delete grant or policy for anon or authenticated on
  this table; the only writer is app.grant_cards (SECURITY DEFINER, called
  only from server code running as service_role). SPEC §9.1 trust model:
  a profile may only "Read a projection" of its own entitlements.$$;

comment on column public.collection.quantity is
  $$Current owned copies of card_id. Clamping at zero is a constraint
  violation (quantity >= 0), never a silent clamp -- see app.grant_cards.$$;

create index if not exists collection_profile_idx
  on public.collection (profile_id);

alter table public.collection enable row level security;

drop trigger if exists collection_set_updated_at on public.collection;
create trigger collection_set_updated_at
  before update on public.collection
  for each row execute function app.set_updated_at();

-- SPEC §9.1: a profile reads only its own rows. No insert/update/delete
-- policy is created for any client role -- RLS defaults to deny, and that
-- default is the enforcement mechanism for "no client path writes either".
drop policy if exists collection_select_own on public.collection;
create policy collection_select_own
  on public.collection
  for select
  to authenticated
  using (profile_id = app.current_profile_id());

-- ----------------------------------------------------------------------------
-- public.collection_grants — append-only audit of every collection change.
-- ----------------------------------------------------------------------------
create table if not exists public.collection_grants (
  id         bigint generated always as identity primary key,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  card_id    text not null references public.cards(id),
  delta      int  not null check (delta <> 0),
  reason     text not null,
  ref        text,
  at         timestamptz not null default now(),
  constraint collection_grants_reason_check check (
    -- ARCHITECTURE-CCG.md §4 lists 'pack' | 'craft' | 'reward' | 'refund'
    -- | 'admin'. 'launch' is added for app.grant_launch_collection.
    -- SPEC §11 R111: 'launch' as a distinct reason. Chosen so the launch-mode
    -- grant (SPEC §9.1 "Everyone owns every card at launch") is
    -- distinguishable in the ledger from a later 'admin' correction or a
    -- 'reward' grant, without overloading an existing reason.
    reason in ('pack', 'craft', 'reward', 'refund', 'admin', 'launch')
  )
);

comment on table public.collection_grants is
  $$SPEC §9.4: append-only audit of every collection change; "Every
  collection change writes `collection` and `collection_grants` in one
  transaction, and no client path writes either." Reconstructs how a
  profile came to own a card. Append-only is enforced as a database
  property via collection_grants_deny_mutation below, not a convention.$$;

comment on column public.collection_grants.delta is
  $$Signed change applied to collection.quantity for (profile_id, card_id).
  Positive for a grant, negative for a reclaim/refund. Never zero.$$;

comment on column public.collection_grants.reason is
  $$See collection_grants_reason_check for the closed set of values.$$;

comment on column public.collection_grants.ref is
  $$Free-form external reference for the grant (pack id, order id,
  admin ticket, or 'launch:<catalog_version>' for launch-mode grants).
  Nullable: not every reason has an external reference.$$;

create index if not exists collection_grants_profile_at_idx
  on public.collection_grants (profile_id, at desc);

alter table public.collection_grants enable row level security;

-- Append-only: attach app.deny_row_mutation() so no row, once written, can
-- be changed or removed by any role (service_role included -- the audit
-- trail for a mistaken grant is a new offsetting grant, not an edit).
drop trigger if exists collection_grants_deny_mutation on public.collection_grants;
create trigger collection_grants_deny_mutation
  before update or delete on public.collection_grants
  for each row execute function app.deny_row_mutation();

-- SPEC §9.1: a profile reads only its own rows. No write policy for any
-- client role -- RLS default deny is the enforcement for "no client path
-- writes either".
drop policy if exists collection_grants_select_own on public.collection_grants;
create policy collection_grants_select_own
  on public.collection_grants
  for select
  to authenticated
  using (profile_id = app.current_profile_id());

-- ----------------------------------------------------------------------------
-- app.grant_cards — the one transactional mutation path for the ledger.
-- ----------------------------------------------------------------------------
-- SPEC §9.4: "Every collection change writes `collection` and
-- `collection_grants` in one transaction, and no client path writes
-- either." This function is that one path. There is deliberately no API
-- endpoint that reaches it from a client -- it is called only by trusted
-- server code running as service_role (or by the other app.* functions
-- below), never proxied through a client-writable RPC.
create or replace function app.grant_cards(
  p_profile_id uuid,
  p_items      jsonb,   -- [{"card_id": "core-043", "delta": 1}, ...]
  p_reason     text,
  p_ref        text default null
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item    jsonb;
  v_card_id text;
  v_delta   int;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'app.grant_cards: p_items must be a jsonb array of {card_id, delta}';
  end if;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_card_id := v_item ->> 'card_id';
    v_delta   := (v_item ->> 'delta')::int;

    if v_card_id is null or v_delta is null or v_delta = 0 then
      raise exception 'app.grant_cards: each item needs a card_id and a non-zero delta';
    end if;

    -- Writes collection ... (upsert; quantity >= 0 is a table constraint,
    -- so a delta that would drop a profile below zero raises here rather
    -- than clamping silently -- this is what lets the BUILD M6-T2
    -- fault-injection test observe "writes both tables or neither": an
    -- unhandled exception anywhere in this loop aborts the whole function
    -- call, rolling back every insert/update this invocation made so far).
    insert into public.collection (profile_id, card_id, quantity, updated_at)
    values (p_profile_id, v_card_id, v_delta, now())
    on conflict (profile_id, card_id)
    do update set quantity   = collection.quantity + excluded.quantity,
                  updated_at = now();

    -- ... and collection_grants, in the same statement pair, same call.
    insert into public.collection_grants (profile_id, card_id, delta, reason, ref)
    values (p_profile_id, v_card_id, v_delta, p_reason, p_ref);
  end loop;
end;
$$;

comment on function app.grant_cards(uuid, jsonb, text, text) is
  $$SPEC §9.4's one transactional mutation path for the collection ledger.
  No API endpoint exposes this to a client; call only from server code
  running as service_role or from another app.* function.$$;

-- ----------------------------------------------------------------------------
-- Launch-mode grant: SPEC §9.1 "Everyone owns every card at launch; keep
-- the ledger anyway", and SPEC §9.4 / ARCHITECTURE-CCG.md §4: "If every
-- account owns every card, keep this schema and treat ownership as maximum
-- copies of everything ... so scarcity can arrive later without a
-- migration."
-- ----------------------------------------------------------------------------

-- SPEC §11 R111: the launch quantity itself. SPEC's loadout rule L3 caps a
-- deck at MAX_COPIES (1) of a card, and L4 forbids the same card id in two
-- decks of the loadout, so a single owned copy per card is already enough
-- to build all three decks legally. launch_quantity = 1.
insert into app.settings (key, value)
values ('launch_quantity', to_jsonb(1))
on conflict (key) do nothing;

create or replace function app.grant_launch_collection(p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_launch_quantity int;
begin
  select (app.setting('launch_quantity'))::text::int into v_launch_quantity;

  -- Idempotency: skip any card this profile already has a 'launch' grant
  -- for, rather than computing a delta up to a target quantity.
  -- SPEC §11 R111: this is a choice between two equally valid strategies
  -- (skip already-granted vs. top-up-to-target); "skip" is picked because
  -- it needs no read of the mutable collection.quantity to decide what to
  -- grant, only the append-only collection_grants log, and a second call
  -- for the same profile and catalog version is then a guaranteed no-op.
  -- A later call after the catalog has grown grants only the new cards.
  perform app.grant_cards(
    p_profile_id,
    coalesce(
      (
        select jsonb_agg(jsonb_build_object('card_id', c.id, 'delta', v_launch_quantity))
        from public.cards c
        where c.catalog_version = app.catalog_version()
          and c.token = false -- SPEC loadout rule L3: "no Token-tagged cards"
          and not exists (
            select 1
            from public.collection_grants g
            where g.profile_id = p_profile_id
              and g.card_id = c.id
              and g.reason = 'launch'
          )
      ),
      '[]'::jsonb
    ),
    'launch',
    'launch:' || app.catalog_version()
  );
end;
$$;

comment on function app.grant_launch_collection(uuid) is
  $$SPEC §9.1: "Everyone owns every card at launch; keep the ledger
  anyway." Grants app.setting('launch_quantity') copies of every
  non-token card in the current catalog version to one profile, via
  app.grant_cards with reason = 'launch'. Idempotent per profile: see the
  R111 comment in the function body for which idempotency strategy
  is used.$$;

create or replace function app.grant_launch_collection_all()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count    int := 0;
  v_profile  record;
begin
  -- SPEC §9.6 build order step 3: "Collection ledger; grant everything to
  -- everyone." Backfill for every currently active profile; safe to run
  -- repeatedly because app.grant_launch_collection is itself idempotent.
  for v_profile in
    select id from public.profiles where status = 'active'
  loop
    perform app.grant_launch_collection(v_profile.id);
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

comment on function app.grant_launch_collection_all() is
  $$Backfill: calls app.grant_launch_collection for every active profile.
  Returns the number of active profiles touched (visited), not the number
  that received new grants -- a repeat run touches the same count safely.$$;

-- SPEC §9.4: "Redeeming an invite code flips pending to active." This
-- trigger is how a freshly redeemed account gets its launch collection
-- with no separate operator step.
create or replace function app.on_profile_activated()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.grant_launch_collection(new.id);
  return new;
end;
$$;

drop trigger if exists profiles_grant_launch_collection on public.profiles;
create trigger profiles_grant_launch_collection
  after update of status on public.profiles
  for each row
  when (new.status = 'active' and old.status <> 'active')
  execute function app.on_profile_activated();

-- ----------------------------------------------------------------------------
-- app.assert_catalog_version — the stale-catalog-version gate.
-- ----------------------------------------------------------------------------
-- SPEC §9.4: "stale catalog version is rejected at save and queue."
-- BUILD M6-T2 acceptance: "a stale `catalogVersion` gets 'update
-- required'." The exception message is exactly "update required" so the
-- calling server code (loadout save / queue endpoints, added in 0003) can
-- map this specific error to the client-facing message by matching on it,
-- rather than treating every error from these functions as generic.
create or replace function app.assert_catalog_version(p_version text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_version is distinct from app.catalog_version() then
    raise exception 'update required';
  end if;
end;
$$;

comment on function app.assert_catalog_version(text) is
  $$SPEC §9.4 stale-catalog-version gate. Raises exactly the message
  "update required" (BUILD M6-T2) when p_version <> app.catalog_version(),
  for the caller to map to its client-facing "update required" response.$$;

-- ============================================================================
-- Explicit grants (default-deny first: revoke everything, then grant back
-- only what SPEC §9.1/§9.4/§9.8 allow).
-- ============================================================================
revoke all on public.cards             from public, anon, authenticated;
revoke all on public.collection        from public, anon, authenticated;
revoke all on public.collection_grants from public, anon, authenticated;

grant select on public.cards to authenticated;
grant select on public.collection to authenticated;
grant select on public.collection_grants to authenticated;

revoke all on function app.grant_cards(uuid, jsonb, text, text)  from public;
revoke all on function app.grant_launch_collection(uuid)         from public;
revoke all on function app.grant_launch_collection_all()         from public;
revoke all on function app.assert_catalog_version(text)          from public;

grant execute on function app.grant_cards(uuid, jsonb, text, text) to service_role;
grant execute on function app.grant_launch_collection(uuid)        to service_role;
grant execute on function app.grant_launch_collection_all()        to service_role;
grant execute on function app.assert_catalog_version(text)         to service_role;

-- ----------------------------------------------------------------------------
-- Closing summary of what this schema lets each role do.
-- ----------------------------------------------------------------------------
-- anon:          nothing on cards, collection or collection_grants.
-- authenticated: SELECT on public.cards (the whole static catalog
--                projection); SELECT on public.collection and
--                public.collection_grants, filtered by RLS to rows where
--                profile_id = app.current_profile_id() (its own entitlements
--                and its own grant history only). No INSERT, UPDATE or
--                DELETE grant or policy exists for authenticated on any of
--                the three tables, and no EXECUTE grant exists for
--                authenticated on app.grant_cards, app.grant_launch_collection,
--                app.grant_launch_collection_all or
--                app.assert_catalog_version -- there is no client-writable
--                path to the collection ledger (SPEC §9.4, §9.8).
-- service_role:  BYPASSRLS covers reads/writes to all three tables; the
--                four app.* functions above are additionally granted
--                EXECUTE explicitly so the API/match server can call them.
-- Every other mutation (per-card grants, the launch grant, the backfill,
-- the catalog-version check) is reachable only through app.grant_cards,
-- app.grant_launch_collection, app.grant_launch_collection_all and
-- app.assert_catalog_version, or through the app.on_profile_activated
-- trigger fired by public.profiles itself -- never through a client
-- request.
-- ============================================================================
