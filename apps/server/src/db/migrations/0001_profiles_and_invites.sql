-- =============================================================================
-- 0001_profiles_and_invites.sql
--
-- Serves SPEC §9.4 "Accounts, collection, loadouts" (the account/invite half)
-- and the abuse mitigations of SPEC §9.8 that guard it, per ARCHITECTURE-CCG.md
-- §3 "Accounts and the invite gate". BUILD.md M6-T1.
--
-- Apply order for the M6 schema is 0001 -> 0002 -> 0003 -> 0004. This file is
-- 0001: it owns the `app` private schema and every object shared across the
-- other three (app.settings, app.setting, app.catalog_version,
-- app.current_profile_id, app.profile_is_active, app.deny_row_mutation,
-- app.set_updated_at) plus public.profiles, public.invite_codes and
-- public.code_attempts. 0002 (cards/collection), 0003 (loadouts) and 0004
-- (matches) depend on the objects defined here; nothing here depends on them.
-- public.cards does not exist yet (it arrives in 0002), so nothing in this
-- file references it — card ids are plain `text` wherever they appear.
--
-- Target: Supabase Postgres 15+. Runs top to bottom on a fresh project with
-- no manual steps, and is safe to re-apply (create-if-not-exists / drop-if-
-- exists-then-create throughout).
-- =============================================================================


-- =============================================================================
-- 1. The `app` schema: private server-side plumbing, never exposed through
--    the Supabase Data API (PostgREST only serves schemas it is configured
--    to expose, and `app` is deliberately not one of them). SECURITY DEFINER
--    functions live here, never in `public` (project rule).
-- =============================================================================

create schema if not exists app;

comment on schema app is
  'Private application schema (SPEC §9.1: identity/entitlement truth lives on '
  'the server, the client may only "read a projection"). Holds SECURITY '
  'DEFINER helpers and internal config. Not exposed through the Data API.';

-- Default-deny first, then the narrowest grant that works.
--
-- `authenticated` needs USAGE on this schema for one reason only: the RLS
-- policies in 0002-0004 call app.current_profile_id(), and a policy expression
-- is evaluated with the privileges of the querying role, so without schema
-- USAGE that name cannot even be resolved and every own-row read fails with
-- "permission denied for schema app". USAGE on a schema conveys nothing by
-- itself — every object inside still needs its own grant, and below only
-- app.current_profile_id() and app.profile_is_active() get EXECUTE for
-- `authenticated`. The Data API does not expose `app` (SPEC §9.1: the client
-- reads a projection), so there is no HTTP route into this schema either way.
--
-- `anon` gets nothing: table privileges are checked before RLS, so an
-- unauthenticated request is refused before any policy expression runs.
revoke all on schema app from anon, authenticated;
grant usage on schema app to postgres, service_role, authenticated;


-- -----------------------------------------------------------------------------
-- app.settings — internal key/value config. Other migrations `insert ... on
-- conflict (key) do nothing` their own keys here, so this table intentionally
-- carries no check constraint on `key` that would foreclose that.
-- -----------------------------------------------------------------------------

create table if not exists app.settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

comment on table app.settings is
  'Internal key/value config for the app schema. Not part of SPEC directly; '
  'Supabase-idiomatic plumbing seeded here with catalog_version (SPEC §9.4) '
  'and the redemption circuit-breaker knobs (SPEC §9.4) app.redeem_invite_code() '
  'reads. Every migration is free to insert its own keys with ON CONFLICT DO NOTHING.';


-- app.set_updated_at() is defined below (§2); the trigger is attached there.


-- =============================================================================
-- 2. Shared functions.
-- =============================================================================

-- app.setting(key): the single read path into app.settings.
create or replace function app.setting(p_key text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select s.value from app.settings s where s.key = p_key;
$$;

comment on function app.setting(text) is
  'Internal key/value read for app.settings. Underlies app.catalog_version() '
  'and the redemption circuit-breaker knobs read by app.redeem_invite_code() '
  '(SPEC §9.4).';

-- Server-side only: no RLS policy in 0002-0004 reads a setting, so
-- `authenticated` gets no EXECUTE here (schema USAGE alone conveys nothing).
revoke execute on function app.setting(text) from public;
grant execute on function app.setting(text) to postgres, service_role;


-- app.catalog_version(): "stale catalog version is rejected at save and
-- queue" (SPEC §9.4). Single source of truth for the currently-live catalog.
create or replace function app.catalog_version()
returns text
language sql
stable
set search_path = ''
as $$
  select app.setting('catalog_version') #>> '{}';
$$;

comment on function app.catalog_version() is
  'SPEC §9.4: "stale catalog version is rejected at save and queue." Reads '
  'app.settings key catalog_version (seeded below as "core-1").';

-- Server-side only, for the same reason as app.setting() above.
revoke execute on function app.catalog_version() from public;
grant execute on function app.catalog_version() to postgres, service_role;


-- app.current_profile_id(): one spelling for "the calling profile" so RLS
-- policies and app functions everywhere read the same way (SPEC §9.1: the
-- client acts only as itself, never states an identity it doesn't hold).
create or replace function app.current_profile_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select auth.uid();
$$;

comment on function app.current_profile_id() is
  'Stable wrapper over auth.uid(); the one spelling every RLS policy and app '
  'function in this project uses for "the calling profile" (SPEC §9.1).';

revoke execute on function app.current_profile_id() from public;
grant execute on function app.current_profile_id() to postgres, service_role, authenticated;


-- app.profile_is_active(): SPEC §9.4 — "A pending account can log in, verify
-- its email and see the code screen, and nothing else: no collection,
-- loadout, queue or match." This is the predicate 0002/0003/0004's RLS
-- policies use to enforce that. SECURITY DEFINER so its own read of
-- public.profiles bypasses RLS on profiles (table ownership), which is what
-- lets it be called FROM another table's RLS policy without ever recursing
-- into a policy defined on profiles itself.
-- plpgsql, not sql: a `language sql` body is parsed when the function is
-- created, and this one reads public.profiles, which §3 below creates. plpgsql
-- resolves its body on first execution instead, so the shared helpers can all
-- stay together at the top of the file where the other migrations look for them.
create or replace function app.profile_is_active()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.status = 'active'
  );
end;
$$;

comment on function app.profile_is_active() is
  'SPEC §9.4: true only for an active caller. SECURITY DEFINER so it never '
  'recurses into a policy that itself calls app.profile_is_active(). Callable '
  'from RLS policies on any public table; not directly useful to a browser '
  'since `app` carries no Data API route.';

revoke execute on function app.profile_is_active() from public;
grant execute on function app.profile_is_active() to postgres, service_role, authenticated;


-- app.deny_row_mutation(): generic guard for append-only ledgers. Not used
-- by any table in this migration; attached by 0002 (collection_grants) and
-- 0004 (match_actions) before update or delete. Defined here because it is
-- shared plumbing, per the cross-migration contract.
create or replace function app.deny_row_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception
    'append-only table %.% may not be updated or deleted (attempted %)',
    tg_table_schema, tg_table_name, tg_op;
end;
$$;

comment on function app.deny_row_mutation() is
  'SPEC-driven append-only guard: collection_grants and match_actions are '
  'audit ledgers that must never be edited or removed after the fact. '
  'Attached "before update or delete" by migrations 0002 and 0004.';

revoke execute on function app.deny_row_mutation() from public;
grant execute on function app.deny_row_mutation() to postgres, service_role;


-- app.set_updated_at(): generic updated_at maintenance, shared by every
-- migration that carries an updated_at column.
create or replace function app.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function app.set_updated_at() is
  'Generic updated_at maintenance trigger shared by every migration in this project.';

revoke execute on function app.set_updated_at() from public;
grant execute on function app.set_updated_at() to postgres, service_role;

-- Now that app.set_updated_at() exists, attach it to app.settings itself.
drop trigger if exists settings_set_updated_at on app.settings;
create trigger settings_set_updated_at
  before update on app.settings
  for each row
  execute function app.set_updated_at();

-- Seed the keys other migrations and app.redeem_invite_code() depend on.
-- Later migrations add their own keys with `on conflict (key) do nothing`.
insert into app.settings (key, value) values
  ('catalog_version', '"core-1"'),                    -- SPEC §9.4
  ('redemption_enabled', 'true'),                      -- SPEC §9.4 circuit breaker
  ('redemption_failure_threshold', '100'),             -- SPEC §11 R106; see the note in redeem_invite_code
  ('redemption_failure_window_seconds', '600')         -- SPEC §11 R106; see the note in redeem_invite_code
on conflict (key) do nothing;


-- =============================================================================
-- 3. public.profiles — SPEC §9.4: "Managed auth provider; profiles.status in
--    pending, active, banned." Keyed 1:1 to auth.users, which Supabase Auth
--    owns exclusively (signup, login, password, email verification).
-- =============================================================================

create table if not exists public.profiles (
  id                uuid primary key references auth.users(id) on delete cascade,
  status            text not null default 'pending'
                       check (status in ('pending', 'active', 'banned')),
  display_name      text,
  rating            int not null default 1000,
  -- SPEC §9.5 / R79: this player's current match, if any. Deliberately no
  -- foreign key here — public.matches does not exist until migration 0004,
  -- which adds `references public.matches(id)`. Do not add one in 0001.
  current_match_id  uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  activated_at      timestamptz
);

comment on table public.profiles is
  'SPEC §9.4: one row per auth.users identity carrying account status '
  '(pending/active/banned) and match/rating state. Identity and entitlement '
  'truth lives on the server (§9.1) — the client may only read its own row.';

comment on column public.profiles.status is
  'SPEC §9.4: "profiles.status in pending, active, banned. A pending account '
  'can log in, verify its email and see the code screen, and nothing else: '
  'no collection, loadout, queue or match. Redeeming an invite code flips '
  'pending to active."';

comment on column public.profiles.display_name is
  'Client-proposed display name. No SPEC clause requires this column; kept '
  'nullable with no format constraint (not in SPEC; no R-row, cosmetic only).';

comment on column public.profiles.rating is
  'R79: "Elo ratings with K = 32 starting at 1000." Updated by the results '
  'API (M7-T2), never by the client.';

comment on column public.profiles.current_match_id is
  'SPEC §9.5 (match lifecycle). No foreign key in this migration: '
  'public.matches does not exist until migration 0004, which adds '
  '`references public.matches(id)`.';

comment on column public.profiles.activated_at is
  'SPEC §9.4 step 6: set when app.redeem_invite_code() flips status from '
  'pending to active.';

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row
  execute function app.set_updated_at();

alter table public.profiles enable row level security;

-- SPEC §9.1: "Identity and entitlement | Server | Read a projection". A
-- profile is visible only to the identity it belongs to; nobody sees anyone
-- else's status, rating or match pointer.
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own
  on public.profiles
  for select
  to authenticated
  using (id = auth.uid());

-- No insert/update/delete policy exists, anywhere, for anon or authenticated:
-- there is no client write path onto profiles (SPEC §9.4 — status flips only
-- through app.redeem_invite_code(); rating/current_match_id only through the
-- server-run match actor and results API). This is intentional, not an
-- oversight: if a future feature needs the player to rename themselves, add
-- it as a *column-level* grant `grant update (display_name) on public.profiles
-- to authenticated`, paired with a policy such as
-- `for update to authenticated using (id = auth.uid()) with check (id = auth.uid())`
-- restricted to that one column — never a blanket UPDATE policy. That pair
-- is deliberately absent from this migration.

revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;


-- -----------------------------------------------------------------------------
-- app.handle_new_user(): SPEC §9.4 — "A pending account can log in, verify
-- its email and see the code screen." For that to be true the instant
-- someone signs up, every auth.users row needs a matching profiles row, made
-- 'pending' automatically, so a fresh Supabase project needs no manual step.
-- SECURITY DEFINER: the role that inserts into auth.users during signup
-- (Supabase Auth's own service role) is not the owner of public.profiles and
-- has no reason to be granted a direct INSERT on it; running as the function
-- owner (postgres) lets this succeed regardless of that, and bypasses RLS on
-- profiles the same way any table-owner write does.
-- -----------------------------------------------------------------------------

create or replace function app.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, status)
  values (new.id, 'pending')
  on conflict (id) do nothing;
  return new;
end;
$$;

comment on function app.handle_new_user() is
  'SPEC §9.4: provisions the pending public.profiles row for a new '
  'auth.users identity, so the code screen described in §9.4 is reachable '
  'immediately after signup with no manual setup step.';

revoke execute on function app.handle_new_user() from public;

-- Guard against duplicating the trigger on a migration re-apply.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function app.handle_new_user();


-- =============================================================================
-- 4. public.invite_codes — ARCHITECTURE-CCG.md §3.2, refined per SPEC §9.4:
--    "Codes: 16 characters (80 bits) from a 32-symbol alphabet without
--    0/O/1/I/l, formatted XXXX-XXXX-XXXX-XXXX, stored hashed."
-- =============================================================================

create table if not exists public.invite_codes (
  id          uuid primary key default gen_random_uuid(),
  -- Never the plaintext (ARCHITECTURE §3.2). The plaintext code is hashed
  -- IN THE SERVER with an HMAC over a server-only CODE_PEPPER (an app secret,
  -- e.g. an environment variable) before it ever reaches Postgres, so the
  -- pepper — and therefore the ability to verify a guess — never lives in
  -- the database. Only the resulting hash is stored or compared here.
  code_hash   text not null unique,
  label       text,
  max_uses    int not null default 1
                constraint invite_codes_max_uses_positive check (max_uses >= 1),
  uses        int not null default 0
                check (uses >= 0 and uses <= max_uses),
  expires_at  timestamptz,
  revoked_at  timestamptz,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);

comment on table public.invite_codes is
  'SPEC §9.4 / §9.8: invite-gate codes. RLS is enabled with zero policies '
  'and zero grants to anon/authenticated — the client must never see a code '
  'row, not even a count of them (§9.8 "Invite code brute force"). Only '
  'server-side code (service_role, via app.redeem_invite_code()) touches '
  'this table.';

comment on column public.invite_codes.code_hash is
  'HMAC(code, CODE_PEPPER) computed server-side; CODE_PEPPER never lives in '
  'Postgres, so this table alone cannot be used to verify or recover a '
  'working code (ARCHITECTURE §3.2, SPEC §9.4).';

comment on column public.invite_codes.max_uses is
  '-- Not in SPEC and no R-row: `max_uses >= 1` is data integrity, not a rule (a '
  'code that permits zero uses is meaningless); ARCHITECTURE §3.2 does not '
  'state this explicitly.';

comment on column public.invite_codes.uses is
  'SPEC §9.4 step 6: "increment uses and set the account active, '
  'atomically." Incremented only under a `for update` row lock in '
  'app.redeem_invite_code(), so two concurrent redemptions cannot both '
  'consume the last use.';

alter table public.invite_codes enable row level security;

-- Deliberately zero policies: default-deny means no row is ever visible or
-- writable to anon/authenticated through the Data API (SPEC §9.8).

revoke all on public.invite_codes from anon, authenticated;
-- No grant at all to anon/authenticated: not even SELECT. A client that can
-- see zero rows vs one row already leaks whether a code table has entries;
-- the only safe answer is no access whatsoever.


-- =============================================================================
-- 5. public.code_attempts — ARCHITECTURE-CCG.md §3.2, the redemption audit
--    log app.redeem_invite_code() reads for its rate limits and the global
--    circuit breaker (SPEC §9.4).
-- =============================================================================

create table if not exists public.code_attempts (
  id         bigint generated always as identity primary key,
  profile_id uuid references public.profiles(id),
  -- Hashed server-side with the same server-only pepper as
  -- invite_codes.code_hash (ARCHITECTURE §3.2: "ip_hash text not null —
  -- hashed with a server-side pepper"). The raw IP address never reaches
  -- this table.
  ip_hash    text not null,
  -- SPEC §9.4 step 4: "log the attempt either way." Written false the
  -- moment the attempt is logged (before the lookup at step 5 runs) and
  -- flipped true only if step 6 goes on to commit the redemption.
  succeeded  boolean not null,
  at         timestamptz not null default now()
);

comment on table public.code_attempts is
  'SPEC §9.4: append-only audit of invite-code redemption attempts. Backs '
  'the per-profile (>5/h), per-IP (>20/h) rate limits and the global '
  'circuit breaker in app.redeem_invite_code(). RLS enabled, no client '
  'policies — only server-side code ever reads or writes this table.';

comment on column public.code_attempts.ip_hash is
  'Hashed server-side with the same server-only pepper as '
  'invite_codes.code_hash (ARCHITECTURE §3.2); never the raw IP address.';

comment on column public.code_attempts.succeeded is
  'SPEC §9.4 step 4 ("log the attempt either way") vs step 6 (the actual '
  'redemption). app.redeem_invite_code() inserts this row false, then '
  'updates it true only on a successful step 6 — the only write this '
  'append-mostly table permits after insert, and only from that function.';

alter table public.code_attempts enable row level security;

-- Deliberately zero policies for anon/authenticated (SPEC §9.4/§9.8): a
-- client must never see its own or anyone else's redemption attempt history.

revoke all on public.code_attempts from anon, authenticated;

-- Indexes for app.redeem_invite_code()'s three rate checks.
create index if not exists code_attempts_profile_recent_idx
  on public.code_attempts (profile_id, at desc);

create index if not exists code_attempts_ip_recent_idx
  on public.code_attempts (ip_hash, at desc);

-- Partial index over recent failures, for the global circuit breaker's
-- "system-wide failures ... within a window" scan (SPEC §9.4).
create index if not exists code_attempts_recent_failures_idx
  on public.code_attempts (at desc)
  where succeeded = false;


-- =============================================================================
-- 6. app.redeem_invite_code — SPEC §9.4's six-step redemption transaction,
--    quoted step by step below, in SPEC's order. Never raises for an
--    expected rejection: it always returns a result code, so that step 4's
--    insert into public.code_attempts is never rolled back by a later
--    rejection in the same call.
--
--    Result codes (exactly these strings): 'ok', 'not_pending',
--    'email_unverified', 'rate_limited_profile', 'rate_limited_ip',
--    'circuit_open', 'invalid_code'. Per SPEC §9.4 — "Missing, expired and
--    exhausted codes return an identical error in identical time" — all
--    three collapse onto the single 'invalid_code' result, produced by one
--    lookup and one combined boolean check (never three separate branches),
--    so the SQL work done is identical regardless of which of the three
--    caused it. SQL cannot, on its own, guarantee identical *wall-clock*
--    latency (cache warmth, WAL/IO jitter, connection state all vary) — the
--    server (codes.ts) is responsible for padding every response on this
--    path to a fixed minimum duration before replying, which is what the
--    BUILD M6-T1 acceptance bar of "three failure responses within 5 ms of
--    each other over 50 samples" actually depends on.
--
--    SPEC's steps 1-3 reject *before* the attempt is logged at step 4: a
--    caller that never gets that far never touches public.code_attempts or
--    public.invite_codes at all, per ARCHITECTURE §3.2 "Rate-limit before
--    the lookup, so a flood is cheap to reject." One consequence worth
--    naming: the rate-limit windows in steps 2-3 only count attempts that
--    reached step 4, so a caller who is already rate-limited never adds to
--    their own count by retrying — the count only grows once they clear the
--    cheap checks.
-- =============================================================================

create or replace function app.redeem_invite_code(
  p_profile_id uuid,
  p_code_hash  text,
  p_ip_hash    text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status                  text;
  v_email_confirmed_at      timestamptz;
  v_profile_recent_attempts bigint;
  v_ip_recent_attempts      bigint;
  v_redemption_enabled      boolean;
  v_failure_threshold       int;
  v_failure_window_seconds  int;
  v_circuit_failures        bigint;
  v_attempt_id              bigint;
  v_code_id                 uuid;
  v_code_revoked_at         timestamptz;
  v_code_expires_at         timestamptz;
  v_code_uses               int;
  v_code_max_uses           int;
begin
  -- Step 1 (SPEC §9.4): "reject unless the account is pending with a
  -- verified email." public.profiles has no email column — email lives on
  -- auth.users, which only a SECURITY DEFINER function owned by postgres
  -- (this one) can read; email_confirmed_at is Supabase Auth's own
  -- verification timestamp. `for update of p` takes the profile row lock
  -- this call holds through step 6, so two concurrent redemption attempts
  -- for the same profile serialise instead of racing.
  select p.status, u.email_confirmed_at
    into v_status, v_email_confirmed_at
    from public.profiles p
    join auth.users u on u.id = p.id
   where p.id = p_profile_id
     for update of p;

  if not found or v_status is distinct from 'pending' then
    return 'not_pending';
  end if;

  if v_email_confirmed_at is null then
    return 'email_unverified';
  end if;

  -- Step 2 (SPEC §9.4): "reject if this profile made more than 5 attempts
  -- in the last hour."
  select count(*)
    into v_profile_recent_attempts
    from public.code_attempts
   where profile_id = p_profile_id
     and at > now() - interval '1 hour';

  if v_profile_recent_attempts > 5 then
    return 'rate_limited_profile';
  end if;

  -- Step 3 (SPEC §9.4): "reject if this IP hash made more than 20."
  select count(*)
    into v_ip_recent_attempts
    from public.code_attempts
   where ip_hash = p_ip_hash
     and at > now() - interval '1 hour';

  if v_ip_recent_attempts > 20 then
    return 'rate_limited_ip';
  end if;

  -- Global circuit breaker (SPEC §9.4), placed "before the lookup" (step 5)
  -- as instructed: "A global circuit breaker disables redemption and alerts
  -- when system-wide failures cross a threshold in a window."
  -- SPEC §11 R106 fixes the threshold and window, which §9.4 requires and does
  -- not name: 100 system-wide failures within 600 seconds. Both are seeded into
  -- app.settings above, so tuning them needs no migration; change R106 too if a
  -- better number turns up, since the row is what this comment answers to.
  v_redemption_enabled := coalesce((app.setting('redemption_enabled') #>> '{}')::boolean, true);
  v_failure_threshold := coalesce((app.setting('redemption_failure_threshold') #>> '{}')::int, 100);
  v_failure_window_seconds :=
    coalesce((app.setting('redemption_failure_window_seconds') #>> '{}')::int, 600);

  if not v_redemption_enabled then
    insert into public.code_attempts (profile_id, ip_hash, succeeded)
    values (p_profile_id, p_ip_hash, false);
    return 'circuit_open';
  end if;

  select count(*)
    into v_circuit_failures
    from public.code_attempts
   where succeeded = false
     and at > now() - make_interval(secs => v_failure_window_seconds);

  if v_circuit_failures > v_failure_threshold then
    insert into public.code_attempts (profile_id, ip_hash, succeeded)
    values (p_profile_id, p_ip_hash, false);
    return 'circuit_open';
  end if;

  -- Step 4 (SPEC §9.4): "log the attempt either way." Logged now, before the
  -- lookup at step 5, exactly as SPEC orders it — written false and flipped
  -- true only if step 6 below actually commits the redemption. Because this
  -- insert happens before we know the outcome, it is deliberately not
  -- protected by app.deny_row_mutation() the way collection_grants and
  -- match_actions are (§ shared-object contract): this one function is the
  -- only writer, and it performs exactly one follow-up UPDATE of its own row.
  insert into public.code_attempts (profile_id, ip_hash, succeeded)
  values (p_profile_id, p_ip_hash, false)
  returning id into v_attempt_id;

  -- Step 5 (SPEC §9.4): "look up by hash and reject if revoked, expired or
  -- exhausted." `for update` takes the code row's lock now, so a concurrent
  -- redemption of the same code blocks here rather than both passing this
  -- check and over-consuming the last use.
  select id, revoked_at, expires_at, uses, max_uses
    into v_code_id, v_code_revoked_at, v_code_expires_at, v_code_uses, v_code_max_uses
    from public.invite_codes
   where code_hash = p_code_hash
     for update;

  -- Missing, revoked, expired and exhausted are one combined boolean check
  -- collapsing to one result, per SPEC §9.4: "Missing, expired and exhausted
  -- codes return an identical error in identical time."
  if not found
     or v_code_revoked_at is not null
     or (v_code_expires_at is not null and v_code_expires_at <= now())
     or v_code_uses >= v_code_max_uses
  then
    return 'invalid_code';
  end if;

  -- Step 6 (SPEC §9.4): "increment uses and set the account active,
  -- atomically." Both writes, plus flipping the step-4 log row to
  -- succeeded, commit together with everything above as one statement-level
  -- transaction.
  update public.invite_codes
     set uses = uses + 1
   where id = v_code_id;

  update public.profiles
     set status = 'active',
         activated_at = now()
   where id = p_profile_id;

  update public.code_attempts
     set succeeded = true
   where id = v_attempt_id;

  return 'ok';
end;
$$;

comment on function app.redeem_invite_code(uuid, text, text) is
  'SPEC §9.4: the six-step invite-code redemption transaction, quoted step '
  'by step in the function body. Never raises for an expected rejection — '
  'always returns one of ''ok'', ''not_pending'', ''email_unverified'', '
  '''rate_limited_profile'', ''rate_limited_ip'', ''circuit_open'', '
  '''invalid_code''. Called only by the server (service_role) from '
  'server/src/api/codes.ts; never reachable from a browser.';

-- Only the server calls this — it is the one function in this migration
-- that mutates account status and consumes a code, so it is the most
-- tightly held grant in the file.
revoke execute on function app.redeem_invite_code(uuid, text, text) from public;
grant execute on function app.redeem_invite_code(uuid, text, text) to service_role;


-- =============================================================================
-- 7. Out of scope for this migration.
--
-- ARCHITECTURE §3.3 "Trusted devices" (a signed device token that skips the
-- code screen after a reinstall) is explicitly optional in both SPEC §9.4
-- ("Trusted devices ... are optional and never authorise an account") and
-- ARCHITECTURE §3.3, and it is not in BUILD M6-T1's file list. Nothing in
-- this migration implements it; when it lands it must not become an
-- authorisation path — profiles.status stays the only source of truth for
-- whether an account may act.
-- =============================================================================


-- =============================================================================
-- 8. Closing grants and summary.
--
-- Belt-and-suspenders: a freshly created table in `public` can carry broad
-- default privileges for anon/authenticated depending on project defaults,
-- and RLS with zero policies is already default-deny on its own. The
-- statements below make both layers agree explicitly, so a mistake in one
-- is never silently masked by the other (SPEC §9.1, §9.8).
-- =============================================================================

revoke all on public.profiles      from anon, authenticated;
revoke all on public.invite_codes  from anon, authenticated;
revoke all on public.code_attempts from anon, authenticated;

grant select on public.profiles to authenticated;
-- public.invite_codes, public.code_attempts: no grant at all to
-- anon/authenticated, on purpose (SPEC §9.8).

revoke all on schema app from anon, authenticated;
-- `authenticated` keeps USAGE (and only USAGE) so that the RLS policies of
-- 0002-0004 can resolve app.current_profile_id(); see the long note in §1.
grant usage on schema app to postgres, service_role, authenticated;

-- What a client can and cannot do with the objects in this migration:
--   * anon           — nothing: no table grant, no schema usage, no function
--                       execute anywhere in this file.
--   * authenticated   — SELECT its own row in public.profiles
--                       (`id = auth.uid()`) and nothing else: no insert,
--                       update or delete on any table here; zero visibility
--                       into public.invite_codes or public.code_attempts;
--                       cannot call app.redeem_invite_code(), app.setting()
--                       or app.catalog_version() at all (no EXECUTE); holds
--                       USAGE on `app` plus EXECUTE on exactly two stable
--                       helpers, app.current_profile_id() and
--                       app.profile_is_active(), because the RLS policies of
--                       0002-0004 call them and a policy expression runs with
--                       the querying role's privileges. The `app` schema
--                       carries no Data API route, so there is no way to call
--                       them other than as the invoker of such a query.
--   * service_role    — full access, BYPASSRLS; this is how
--                       server/src/api/auth.ts and codes.ts verify email
--                       state and redeem codes. It must never be embedded in
--                       a browser bundle (SPEC §9.1 trust model).
-- =============================================================================
