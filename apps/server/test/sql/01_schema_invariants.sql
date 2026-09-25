\set ON_ERROR_STOP on

-- Every check below must FAIL LOUDLY when the invariant in its heading is violated.
-- A `select` that prints rows is a diagnostic, never the check: psql prints "(0 rows)"
-- and moves on whether the answer was right or wrong. So each heading keeps its
-- `select` for the human reading the log, and follows it with a `do $$ ... raise
-- exception 'FAIL (CHECK n): ...' $$` block that is the actual assertion. CHECK 12 has
-- worked this way since it was fixed; the rest now do too.
--
-- `raise exception` + `\set ON_ERROR_STOP on` makes psql exit non-zero, which run.sh
-- turns into a non-zero exit for the whole suite. `raise notice 'FAIL ...'` does NOT
-- stop psql — run.sh greps the output for it as a second net, but inside this file the
-- FAIL path is always `raise exception`.
--
-- Several checks also assert that there was something to measure (a table with rows, a
-- policy that could have leaked, a grant that could have been too wide). An invariant
-- that holds because the schema is empty is the failure mode this file exists to catch.

\echo '=== CHECK 1: every table in public has RLS enabled (must be 0 rows) ==='
select c.relname as table_without_rls
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
 order by 1;
do $$
declare
  offenders text;
  total     bigint;
begin
  select count(*) into total
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r';
  if total = 0 then
    raise exception 'FAIL (CHECK 1): no tables in public — the migrations did not apply';
  end if;

  select string_agg(c.relname, ', ' order by c.relname) into offenders
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  if offenders is not null then
    raise exception 'FAIL (CHECK 1): public tables without RLS: %', offenders;
  end if;

  raise notice 'OK (CHECK 1): all % public tables have RLS enabled', total;
end $$;

\echo '=== CHECK 2: the 16 tables of migrations 0001-0009 ==='
select count(*) as public_tables from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r';
select string_agg(c.relname, ', ' order by c.relname) as tables from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r';
do $$
declare
  -- BUILD M6-T1..T4: profiles/invite_codes/code_attempts (0001), cards/collection/
  -- collection_grants (0002), loadouts/loadout_decks/loadout_deck_cards (0003),
  -- matches/match_actions/tickets/results (0004); then decks/trios (0007, R250, R252) and
  -- series (0009, R263). 0005, 0006 and 0008 add no table. The three loadout tables stay
  -- after 0007, unread and unwritten (R254), so they are still expected here.
  expected constant text[] := array[
    'cards', 'code_attempts', 'collection', 'collection_grants', 'decks', 'invite_codes',
    'loadout_deck_cards', 'loadout_decks', 'loadouts', 'match_actions', 'matches',
    'profiles', 'results', 'series', 'tickets', 'trios'];
  actual  text[];
  missing text[];
  extra   text[];
begin
  select coalesce(array_agg(c.relname order by c.relname), '{}'::text[]) into actual
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r';

  select coalesce(array_agg(e order by e), '{}'::text[]) into missing
    from unnest(expected) e where e <> all (actual);
  select coalesce(array_agg(a order by a), '{}'::text[]) into extra
    from unnest(actual) a where a <> all (expected);

  if cardinality(missing) > 0 then
    raise exception 'FAIL (CHECK 2): missing table(s): %', array_to_string(missing, ', ');
  end if;
  if cardinality(extra) > 0 then
    raise exception
      'FAIL (CHECK 2): unexpected table(s) in public: % — a new table needs an RLS policy, a grant decision and a row here',
      array_to_string(extra, ', ');
  end if;

  raise notice 'OK (CHECK 2): exactly the % expected tables', cardinality(expected);
end $$;

\echo '=== CHECK 3: L4 unique index ==='
select indexdef from pg_indexes where indexname = 'loadout_card_unique';
do $$
declare
  r record;
begin
  -- SPEC §9.4 L4: "a card id appears in at most one deck, also enforced by a unique
  -- index on (profile_id, card_id)". The failure this asserts against is `slot` creeping
  -- into the key: the index would still exist, still be unique, still be named the same,
  -- and enforce nothing beyond the primary key. 0003's own comment says "Do not add
  -- `slot` to this index"; this is that comment as a test.
  select i.indisunique,
         i.indnkeyatts,
         i.indpred is null   as no_predicate,
         i.indexprs is null  as no_expressions,
         t.relname           as table_name,
         (select string_agg(pg_get_indexdef(i.indexrelid, k, true), ', ' order by k)
            from generate_series(1, i.indnkeyatts) k) as key_columns
    into r
    from pg_index i
    join pg_class ic on ic.oid = i.indexrelid
    join pg_class t  on t.oid  = i.indrelid
    join pg_namespace n on n.oid = ic.relnamespace
   where n.nspname = 'public' and ic.relname = 'loadout_card_unique';

  if not found then
    raise exception 'FAIL (CHECK 3): index loadout_card_unique does not exist (SPEC §9.4 L4)';
  end if;
  if r.table_name <> 'loadout_deck_cards' then
    raise exception 'FAIL (CHECK 3): loadout_card_unique is on public.%, not loadout_deck_cards',
      r.table_name;
  end if;
  if not r.indisunique then
    raise exception 'FAIL (CHECK 3): loadout_card_unique is not a UNIQUE index — it enforces nothing';
  end if;
  if r.key_columns is distinct from 'profile_id, card_id' then
    raise exception
      'FAIL (CHECK 3): loadout_card_unique keys on (%), expected (profile_id, card_id) — with `slot` in the key it only repeats the primary key and L4 is unenforced',
      r.key_columns;
  end if;
  if not r.no_predicate or not r.no_expressions then
    raise exception
      'FAIL (CHECK 3): loadout_card_unique is partial or expression-based; L4 must hold for every row';
  end if;

  raise notice 'OK (CHECK 3): unique index loadout_card_unique on loadout_deck_cards (%)',
    r.key_columns;
end $$;

\echo '=== CHECK 4: no SECURITY DEFINER function in the exposed public schema ==='
select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prosecdef order by 1;
do $$
declare
  offenders text;
begin
  -- No vacuity guard is possible here: `public` holds no functions at all today, and the
  -- point of the check is that it stays that way. Every privileged routine lives in `app`,
  -- which anon/authenticated have no USAGE on (0001). A SECURITY DEFINER function in the
  -- PostgREST-exposed schema is a callable escalation, so one appearing is the failure.
  select string_agg(p.proname, ', ' order by p.proname) into offenders
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef;
  if offenders is not null then
    raise exception
      'FAIL (CHECK 4): SECURITY DEFINER function(s) in the exposed public schema: % — privileged code belongs in app',
      offenders;
  end if;
  raise notice 'OK (CHECK 4): no SECURITY DEFINER function in public';
end $$;

\echo '=== CHECK 5: no INSERT/UPDATE/DELETE policy for anon or authenticated ==='
select schemaname, tablename, policyname, cmd, roles
  from pg_policies
 where schemaname = 'public' and cmd <> 'SELECT'
 order by tablename, policyname;
do $$
declare
  offenders  text;
  select_pol bigint;
begin
  -- SPEC §9.4: "no client path writes either". RLS denies by default, so the invariant is
  -- that no write policy ever opens that default. `public` counts as a client role: it
  -- includes anon and authenticated.
  select string_agg(format('%s.%s (%s for %s)', tablename, policyname, cmd,
                           array_to_string(roles, '/')), ', ' order by tablename, policyname)
    into offenders
    from pg_policies
   where schemaname = 'public'
     and cmd <> 'SELECT'
     and roles && array['anon', 'authenticated', 'public']::name[];
  if offenders is not null then
    raise exception 'FAIL (CHECK 5): write policy reachable by a client role: %', offenders;
  end if;

  -- Vacuity guard: "no write policies" means nothing if there are no policies at all.
  select count(*) into select_pol
    from pg_policies
   where schemaname = 'public' and cmd = 'SELECT'
     and roles && array['anon', 'authenticated', 'public']::name[];
  if select_pol = 0 then
    raise exception
      'FAIL (CHECK 5): no SELECT policy for any client role — the schema has no RLS to speak of, so this check measured nothing';
  end if;

  raise notice 'OK (CHECK 5): % client SELECT policies, 0 client write policies', select_pol;
end $$;

\echo '=== CHECK 6: client write privileges on public tables (must be 0 rows) ==='
-- Read the ACLs directly rather than information_schema.role_table_grants, which hides
-- grants whose grantor and grantee are both roles the caller is not a member of, and which
-- does not report grants to PUBLIC at all.
select c.relname as table_name,
       coalesce(g.rolname, 'PUBLIC') as grantee,
       a.privilege_type
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
  left join pg_roles g on g.oid = a.grantee
 where n.nspname = 'public' and c.relkind = 'r'
   and coalesce(g.rolname, 'PUBLIC') in ('anon', 'authenticated', 'PUBLIC')
   and a.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
 order by 1, 2, 3;
do $$
declare
  offenders  text;
  read_grant bigint;
begin
  select string_agg(format('%s:%s:%s', c.relname, coalesce(g.rolname, 'PUBLIC'),
                           a.privilege_type), ', ' order by c.relname, a.privilege_type)
    into offenders
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
    left join pg_roles g on g.oid = a.grantee
   where n.nspname = 'public' and c.relkind = 'r'
     and coalesce(g.rolname, 'PUBLIC') in ('anon', 'authenticated', 'PUBLIC')
     and a.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');
  if offenders is not null then
    raise exception
      'FAIL (CHECK 6): a client role holds write privileges: % — every write goes through an app.* SECURITY DEFINER function',
      offenders;
  end if;

  -- Vacuity guard: authenticated must still be able to READ its projections (SPEC §9.1),
  -- so a schema that revoked everything from everyone is not a pass.
  select count(*) into read_grant
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
    join pg_roles g on g.oid = a.grantee
   where n.nspname = 'public' and c.relkind = 'r'
     and g.rolname = 'authenticated' and a.privilege_type = 'SELECT';
  if read_grant = 0 then
    raise exception
      'FAIL (CHECK 6): authenticated has SELECT on no public table — nothing was granted, so "no write grants" measured nothing';
  end if;

  raise notice 'OK (CHECK 6): 0 client write grants, % authenticated SELECT grants', read_grant;
end $$;

\echo '=== CHECK 7: append-only triggers ==='
select c.relname as table_name, t.tgname
  from pg_trigger t join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and not t.tgisinternal
 order by 1, 2;
do $$
declare
  -- SPEC §9.4 (collection_grants) and §9.3 (the match action log) both say append-only,
  -- and both are enforced by app.deny_row_mutation() fired BEFORE UPDATE OR DELETE FOR
  -- EACH ROW. A listing cannot tell a live guard from a disabled one or from a trigger
  -- that only fires on INSERT, so the flags are asserted, not printed.
  ledgers constant text[] := array['collection_grants', 'match_actions'];
  tbl     text;
  r       record;
begin
  foreach tbl in array ledgers loop
    select t.tgname, t.tgtype, t.tgenabled, p.proname, pn.nspname as pronsp
      into r
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_proc p on p.oid = t.tgfoid
      join pg_namespace pn on pn.oid = p.pronamespace
     where n.nspname = 'public' and c.relname = tbl and not t.tgisinternal
       and p.proname = 'deny_row_mutation';

    if not found then
      raise exception
        'FAIL (CHECK 7): public.% has no app.deny_row_mutation() trigger — the append-only ledger can be rewritten',
        tbl;
    end if;
    if r.pronsp <> 'app' then
      raise exception 'FAIL (CHECK 7): public.% fires %.deny_row_mutation, not app.deny_row_mutation',
        tbl, r.pronsp;
    end if;
    -- tgtype bits: 1 = FOR EACH ROW, 2 = BEFORE, 8 = DELETE, 16 = UPDATE.
    if (r.tgtype & 1) = 0 then
      raise exception 'FAIL (CHECK 7): %.% is a statement trigger; it must be FOR EACH ROW', tbl, r.tgname;
    end if;
    if (r.tgtype & 2) = 0 then
      raise exception 'FAIL (CHECK 7): %.% does not fire BEFORE the write', tbl, r.tgname;
    end if;
    if (r.tgtype & 16) = 0 then
      raise exception 'FAIL (CHECK 7): %.% does not fire on UPDATE — the ledger is editable', tbl, r.tgname;
    end if;
    if (r.tgtype & 8) = 0 then
      raise exception 'FAIL (CHECK 7): %.% does not fire on DELETE — the ledger is erasable', tbl, r.tgname;
    end if;
    -- tgenabled: 'O' fires normally, 'A' always; 'D' disabled, 'R' replica-only.
    if r.tgenabled not in ('O', 'A') then
      raise exception 'FAIL (CHECK 7): %.% is disabled (tgenabled = %)', tbl, r.tgname, r.tgenabled;
    end if;

    raise notice 'OK (CHECK 7): public.% guarded by % (before update or delete, each row)',
      tbl, r.tgname;
  end loop;
end $$;

\echo '=== CHECK 8: signup trigger creates a pending profile ==='
insert into auth.users (id, email, email_confirmed_at)
values ('11111111-1111-1111-1111-111111111111', 'p1@example.test', now()),
       ('22222222-2222-2222-2222-222222222222', 'p2@example.test', null);
select id, status, rating from public.profiles order by id;
do $$
declare
  n   bigint;
  bad text;
begin
  -- SPEC §9.4: a signup lands as `pending` at rating 1000 and owns nothing until a code is
  -- redeemed. The two auth.users rows above are the only input; app.handle_new_user does
  -- the rest, so two profiles is the assertion, not a number to eyeball.
  --
  -- Counted over these two ids, not the whole table: 03b_legacy_loadout_seed.sql signed up and
  -- activated profile 44444444-… before migration 0007 ran, so that 0007 had a loadout to
  -- convert (R254), and that profile is neither new nor pending.
  select count(*) into n from public.profiles
   where id in ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222');
  if n <> 2 then
    raise exception
      'FAIL (CHECK 8): % profile row(s) after 2 signups — app.handle_new_user did not fire for each',
      n;
  end if;

  select string_agg(format('%s status=%s rating=%s activated=%s', id, status, rating,
                           activated_at is not null), '; ' order by id)
    into bad
    from public.profiles
   where id in ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222')
     and (status <> 'pending' or rating <> 1000 or activated_at is not null);
  if bad is not null then
    raise exception 'FAIL (CHECK 8): a fresh profile is not pending/1000/unactivated: %', bad;
  end if;

  select count(*) into n from public.collection
   where profile_id in ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222');
  if n <> 0 then
    raise exception
      'FAIL (CHECK 8): a pending profile already owns % collection row(s) — the launch grant fired before activation',
      n;
  end if;

  raise notice 'OK (CHECK 8): 2 pending profiles at rating 1000, no collection';
end $$;

\echo '=== CHECK 9: redemption — rejections ==='
insert into public.invite_codes (code_hash, label, max_uses)
values ('hash-good', 'bring-up', 2), ('hash-revoked', 'revoked', 1);
update public.invite_codes set revoked_at = now() where code_hash = 'hash-revoked';
do $$
declare
  unverified text;
  missing    text;
  revoked    text;
  attempts   bigint;
  n          bigint;
begin
  -- Each redemption is called exactly once. It is not a pure read: it logs a code_attempt
  -- and counts against the 5-per-hour-per-profile limit (SPEC §9.4), and `hash-good` has
  -- exactly 2 uses which CHECK 10 and 03_match_lifecycle spend. So the values are captured
  -- into variables and raised as a notice rather than re-run for a printable table.
  unverified := app.redeem_invite_code('22222222-2222-2222-2222-222222222222', 'hash-good', 'ip-a');
  missing    := app.redeem_invite_code('11111111-1111-1111-1111-111111111111', 'hash-missing', 'ip-a');
  revoked    := app.redeem_invite_code('11111111-1111-1111-1111-111111111111', 'hash-revoked', 'ip-a');
  raise notice 'CHECK 9: unverified_email=%  missing_code=%  revoked_code=%',
    unverified, missing, revoked;

  if unverified <> 'email_unverified' then
    raise exception
      'FAIL (CHECK 9): profile 2 has an unverified email and redemption returned "%" — SPEC §9.4 step (1)',
      unverified;
  end if;
  -- SPEC §9.4: "Missing, expired and exhausted codes return an identical error in identical
  -- time." Distinguishable answers are the brute-force oracle the invite gate exists to deny.
  if missing <> 'invalid_code' or revoked <> 'invalid_code' then
    raise exception
      'FAIL (CHECK 9): missing="%" revoked="%" — both must be the same opaque invalid_code',
      missing, revoked;
  end if;

  -- SPEC §9.4 step (4): "log the attempt either way". Two attempts, not three: the unverified
  -- email is rejected at step (1), before the attempt log, so only the two code lookups count.
  select count(*) into attempts from public.code_attempts;
  if attempts <> 2 then
    raise exception
      'FAIL (CHECK 9): % code_attempts row(s) after 2 code lookups — a rejected attempt went unlogged',
      attempts;
  end if;
  if exists (select 1 from public.code_attempts where succeeded) then
    raise exception 'FAIL (CHECK 9): a rejected redemption was logged as succeeded';
  end if;

  -- Nothing may have moved: a rejection activates no account and spends no code. (The two
  -- profiles this check redeems for; 03b's legacy profile was active before this file ran.)
  select count(*) into n from public.profiles
   where id in ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222')
     and status <> 'pending';
  if n <> 0 then
    raise exception 'FAIL (CHECK 9): a rejected redemption activated % profile(s)', n;
  end if;
  select count(*) into n from public.invite_codes where uses <> 0;
  if n <> 0 then
    raise exception 'FAIL (CHECK 9): a rejected redemption consumed % code(s)', n;
  end if;

  raise notice 'OK (CHECK 9): 3 rejections, 2 logged attempts, 0 activations, 0 codes spent';
end $$;

\echo '=== CHECK 10: redemption — success flips status and fires the launch grant ==='
insert into public.cards (id, card_index, name, set_id, type, tags, rarity, token, cost,
                          catalog_version)
values ('core-001', '1', 'Test Unit', 'Core', 'Unit', '{}', 'Common', false, '1'::jsonb, 'core-1'),
       ('core-002', '2', 'Test Spell', 'Core', 'Spell', '{}', 'Rare', false, '2'::jsonb, 'core-1'),
       ('tok-001', '1.1', 'Test Token', 'Core', 'Unit', '{Token}', 'Token', true, '0'::jsonb,
        'core-1');
do $$
declare
  redeemed text;
begin
  -- One call only: `hash-good` has 2 uses and 03_match_lifecycle needs the second.
  redeemed := app.redeem_invite_code('11111111-1111-1111-1111-111111111111', 'hash-good', 'ip-a');
  raise notice 'CHECK 10: redeem_ok=%', redeemed;
  if redeemed <> 'ok' then
    raise exception 'FAIL (CHECK 10): redemption returned "%", expected ok', redeemed;
  end if;
end $$;
select status, activated_at is not null as activated from public.profiles
 where id = '11111111-1111-1111-1111-111111111111';
select card_id, quantity from public.collection
 where profile_id = '11111111-1111-1111-1111-111111111111' order by card_id;
select card_id, delta, reason from public.collection_grants
 where profile_id = '11111111-1111-1111-1111-111111111111' order by card_id;
do $$
declare
  caller constant uuid := '11111111-1111-1111-1111-111111111111';
  p      record;
  owned  text;
  grants text;
  n      bigint;
begin
  select status, activated_at is not null as activated into p
    from public.profiles where id = caller;
  if p.status <> 'active' or not p.activated then
    raise exception 'FAIL (CHECK 10): profile 1 is status=% activated=% after a successful redemption',
      p.status, p.activated;
  end if;

  -- SPEC §9.4: "Everyone owns every card at launch" — every non-Token card, quantity 1.
  select string_agg(format('%s x%s', card_id, quantity), ', ' order by card_id) into owned
    from public.collection where profile_id = caller;
  if owned is distinct from 'core-001 x1, core-002 x1' then
    raise exception
      'FAIL (CHECK 10): collection is [%], expected [core-001 x1, core-002 x1] — the launch grant is wrong or granted a Token',
      coalesce(owned, '(empty)');
  end if;

  -- "Every collection change writes `collection` and `collection_grants` in one transaction":
  -- the ledger must mirror the balance, not trail it.
  select string_agg(format('%s %s %s', card_id, delta, reason), ', ' order by card_id) into grants
    from public.collection_grants where profile_id = caller;
  if grants is distinct from 'core-001 1 launch, core-002 1 launch' then
    raise exception 'FAIL (CHECK 10): collection_grants is [%], expected one launch grant of 1 per card',
      coalesce(grants, '(empty)');
  end if;

  select count(*) into n from public.invite_codes where code_hash = 'hash-good' and uses = 1;
  if n <> 1 then
    raise exception 'FAIL (CHECK 10): hash-good was not consumed exactly once';
  end if;
  if exists (select 1 from public.code_attempts where profile_id = caller and succeeded) = false then
    raise exception 'FAIL (CHECK 10): the successful redemption was not logged in code_attempts';
  end if;

  raise notice 'OK (CHECK 10): profile 1 active, 2 cards owned, 2 launch grants, 1 code use spent';
end $$;

\echo '=== CHECK 11: collection_grants is append-only (must raise) ==='
do $$
declare
  rows_to_touch bigint;
begin
  -- Vacuity guard: an UPDATE that matches no row fires no row trigger and raises nothing,
  -- which would report the guard as missing rather than as untested. CHECK 10 wrote two
  -- launch grants; assert they are there before trying to edit one.
  select count(*) into rows_to_touch from public.collection_grants where profile_id is not null;
  if rows_to_touch = 0 then
    raise exception 'FAIL (CHECK 11): no collection_grants rows to update — nothing was tested';
  end if;

  update public.collection_grants set delta = 99 where profile_id is not null;
  raise exception 'FAIL (CHECK 11): collection_grants accepted an UPDATE of % row(s)', rows_to_touch;
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  if sqlerrm not like 'append-only table public.collection_grants may not be updated%' then
    raise exception
      'FAIL (CHECK 11): the UPDATE failed with "%" (%), not app.deny_row_mutation — something other than the append-only guard refused it',
      sqlerrm, sqlstate;
  end if;
  raise notice 'OK (CHECK 11): collection_grants refused the UPDATE — %', sqlerrm;
end $$;

\echo '=== CHECK 12: authenticated can read its own row and not the other profile ==='
-- `set local role` only takes effect inside a transaction block. Issued outside one — as this
-- check used to — Postgres answers `WARNING: SET LOCAL can only be used in transaction blocks`,
-- keeps the superuser session, which BYPASSES RLS, and every count below comes back as the whole
-- table while the check still passes. So the probes run inside an explicit transaction, the way
-- 02_rls_as_client.sql does it, and the block at the end raises on a wrong answer instead of
-- leaving a human to notice a number.
--
-- The transaction also seeds one collection row owned by the *other* profile, so "its own rows
-- only" has something to hide (profile 2 is pending here and owns nothing, which would make the
-- collection half of this check vacuous). The rollback puts the database back as CHECK 11 left it.
begin;

insert into public.collection (profile_id, card_id, quantity)
values ('22222222-2222-2222-2222-222222222222', 'core-002', 1);

-- Read as superuser, with RLS bypassed: the totals the client's answers are measured against.
do $$
begin
  perform set_config('check12.profiles_total',
                     (select count(*) from public.profiles)::text, true);
  perform set_config('check12.cards_total',
                     (select count(*) from public.cards)::text, true);
  perform set_config('check12.collection_own',
                     (select count(*) from public.collection
                       where profile_id = '11111111-1111-1111-1111-111111111111')::text, true);
  perform set_config('check12.collection_other',
                     (select count(*) from public.collection
                       where profile_id <> '11111111-1111-1111-1111-111111111111')::text, true);
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);

select count(*) as own_profile_rows from public.profiles;
select count(*) as own_collection_rows from public.collection;
select count(*) as visible_cards from public.cards;

do $$
declare
  caller constant uuid := '11111111-1111-1111-1111-111111111111';
  -- Read with `missing_ok`, defaulting to -1: the totals above are transaction-scoped too, so if
  -- this check ever loses its transaction again the guards below report *that* rather than dying
  -- in a cast.
  profiles_total   bigint := coalesce(nullif(current_setting('check12.profiles_total', true), ''), '-1')::bigint;
  cards_total      bigint := coalesce(nullif(current_setting('check12.cards_total', true), ''), '-1')::bigint;
  collection_own   bigint := coalesce(nullif(current_setting('check12.collection_own', true), ''), '-1')::bigint;
  collection_other bigint := coalesce(nullif(current_setting('check12.collection_other', true), ''), '-1')::bigint;
  seen_profiles    bigint;
  seen_collection  bigint;
  seen_cards       bigint;
  seen_id          uuid;
begin
  -- Without this the whole check is theatre: a superuser reads every row and passes.
  if current_user <> 'authenticated' then
    raise exception 'FAIL (CHECK 12): running as %, not authenticated — SET LOCAL did not take',
      current_user;
  end if;
  if profiles_total < 2 or collection_other < 1 then
    raise exception 'FAIL (CHECK 12): nothing to hide (% profiles, % foreign collection rows)',
      profiles_total, collection_other;
  end if;

  select count(*) into seen_profiles from public.profiles;
  select id into seen_id from public.profiles limit 1;
  select count(*) into seen_collection from public.collection;
  select count(*) into seen_cards from public.cards;

  -- SPEC §9.1: a profile may read a projection of its own row and of nobody else's.
  if seen_profiles <> 1 or seen_id is distinct from caller then
    raise exception 'FAIL (CHECK 12): profiles showed % of % rows (first %), expected only %',
      seen_profiles, profiles_total, seen_id, caller;
  end if;
  if seen_collection <> collection_own then
    raise exception 'FAIL (CHECK 12): collection showed % rows, expected % own (% foreign)',
      seen_collection, collection_own, collection_other;
  end if;
  -- §9.4: the catalog is public to a logged-in user, so hiding it would be a failure too.
  if seen_cards <> cards_total then
    raise exception 'FAIL (CHECK 12): cards showed % of % rows; the catalog is readable',
      seen_cards, cards_total;
  end if;

  raise notice 'OK: 1 own profile row, % own collection rows, % cards, % foreign rows hidden',
    seen_collection, seen_cards, collection_other;
end $$;

reset role;
rollback;

\echo '=== CHECK 13: authenticated cannot read invite_codes or matches ==='
-- Same shape as CHECK 12: an explicit transaction so SET LOCAL ROLE really takes, and a
-- current_user guard so a superuser session cannot pass this by reading everything and
-- being refused nothing. The old version answered an unexpected error ("OK-ish") with a
-- notice, so a dropped table or a renamed schema passed.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
do $$
declare
  forbidden constant text[] := array['invite_codes', 'matches'];
  t text;
  n bigint;
begin
  if current_user <> 'authenticated' then
    raise exception 'FAIL (CHECK 13): running as %, not authenticated — SET LOCAL did not take',
      current_user;
  end if;

  foreach t in array forbidden loop
    begin
      execute format('select count(*) from public.%I', t) into n;
      raise exception 'FAIL (CHECK 13): authenticated read public.% (% rows)', t, n;
    exception
      when insufficient_privilege then
        raise notice 'OK (CHECK 13): public.% refused to authenticated', t;
      when others then
        if sqlerrm like 'FAIL%' then raise; end if;
        raise exception
          'FAIL (CHECK 13): public.% raised "%" (%), not insufficient_privilege — the table is not being refused, it is missing or broken',
          t, sqlerrm, sqlstate;
    end;
  end loop;
end $$;
reset role;
rollback;

\echo '=== CHECK 14: L4 — the unique index refuses a card in two decks ==='
-- BUILD M6-T3 acceptance: "the unique index rejects a duplicate across decks even when the
-- application check is bypassed (raw SQL test)". This is that test — the inserts go straight
-- at the table, never through app.save_loadout.
do $$
declare
  redeemed text;
begin
  -- Profile 2 still has an unverified email, so this must be refused. Asserted rather than
  -- printed: an unexpected 'ok' here would mean CHECK 9's rejection path had stopped working.
  redeemed := app.redeem_invite_code('22222222-2222-2222-2222-222222222222', 'hash-good', 'ip-b');
  if redeemed <> 'email_unverified' then
    raise exception 'FAIL (CHECK 14): profile 2 has no verified email but redeem returned "%"',
      redeemed;
  end if;
  raise notice 'OK (CHECK 14 preflight): profile 2 still needs a verified email';
end $$;
insert into public.loadouts (profile_id, catalog_version)
values ('11111111-1111-1111-1111-111111111111', 'core-1');
insert into public.loadout_decks (profile_id, slot, name) values
  ('11111111-1111-1111-1111-111111111111', 1, 'One'),
  ('11111111-1111-1111-1111-111111111111', 2, 'Two');
insert into public.loadout_deck_cards (profile_id, slot, card_id, count)
values ('11111111-1111-1111-1111-111111111111', 1, 'core-001', 1);
do $$
declare
  seeded     bigint;
  refused_by text;
begin
  -- Vacuity guard: without the deck-1 row above there is no duplicate to make.
  select count(*) into seeded from public.loadout_deck_cards
   where profile_id = '11111111-1111-1111-1111-111111111111'
     and slot = 1 and card_id = 'core-001';
  if seeded <> 1 then
    raise exception 'FAIL (CHECK 14): the deck-1 row was not seeded; there is no duplicate to refuse';
  end if;

  insert into public.loadout_deck_cards (profile_id, slot, card_id, count)
  values ('11111111-1111-1111-1111-111111111111', 2, 'core-001', 1);
  raise exception 'FAIL (CHECK 14): L4 index allowed the same card in two decks';
exception
  when unique_violation then
    get stacked diagnostics refused_by = constraint_name;
    -- The two rows differ in `slot`, so the (profile_id, slot, card_id) primary key cannot be
    -- what refused this. Naming the index makes that explicit: if `slot` were ever added to
    -- loadout_card_unique, the insert would succeed and the FAIL above would fire instead.
    if refused_by is distinct from 'loadout_card_unique' then
      raise exception
        'FAIL (CHECK 14): the cross-deck duplicate was refused by "%", not loadout_card_unique',
        refused_by;
    end if;
    raise notice 'OK (CHECK 14): loadout_card_unique refused the cross-deck duplicate';
  when others then
    -- The old version raised a `notice` here, so a foreign-key violation, a missing table or a
    -- check constraint printed "UNEXPECTED" and the check still passed.
    if sqlerrm like 'FAIL%' then raise; end if;
    raise exception
      'FAIL (CHECK 14): the cross-deck insert raised "%" (%), not unique_violation — L4 was not what refused it',
      sqlerrm, sqlstate;
end $$;

\echo '=== CHECK 15 (R105): stale catalog version says "update required" ==='
do $$
begin
  perform app.assert_catalog_version('core-999');
  raise exception 'FAIL (CHECK 15): a stale catalog version was accepted';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  -- 0002 raises exactly 'update required' so the API layer can pass it through (BUILD M6-T2).
  -- Accepting any error at all would have let "function does not exist" pass as a rejection.
  if sqlerrm <> 'update required' then
    raise exception
      'FAIL (CHECK 15): stale catalog version raised "%" (%), expected exactly "update required"',
      sqlerrm, sqlstate;
  end if;
  raise notice 'OK (CHECK 15): %', sqlerrm;
end $$;

\echo '=== CHECK 16: matchmaking and match tables exist with their indexes ==='
select indexname from pg_indexes
 where schemaname = 'public' and tablename in ('tickets', 'matches', 'match_actions', 'results')
 order by 1;
do $$
declare
  -- The three *_key indexes are load-bearing behaviour, not tuning: nonce dedupe (SPEC §9.3),
  -- one open match per room code (R110) and one queued ticket per profile (§9.5) are all
  -- "unique index or it does not happen". Losing UNIQUE would leave the name in place and the
  -- rule gone, so uniqueness is asserted per index, not just existence.
  expected constant text[][] := array[
    ['match_actions_nonce_key',       'unique'],
    ['match_actions_pkey',            'unique'],
    ['matches_pkey',                  'unique'],
    ['matches_room_code_open_key',    'unique'],
    ['results_pkey',                  'unique'],
    ['tickets_pkey',                  'unique'],
    ['tickets_profile_queued_key',    'unique'],
    ['matches_p1_profile_id_idx',     'any'],
    ['matches_p2_profile_id_idx',     'any'],
    ['matches_status_ceiling_at_idx', 'any'],
    ['matches_status_created_at_idx', 'any'],
    ['results_p1_ended_at_idx',       'any'],
    ['results_p2_ended_at_idx',       'any'],
    ['tickets_pairing_scan_idx',      'any']];
  idx_name text;
  idx_kind text;
  is_unique boolean;
  i int;
begin
  for i in 1 .. array_length(expected, 1) loop
    idx_name := expected[i][1];
    idx_kind := expected[i][2];
    select x.indisunique into is_unique
      from pg_index x
      join pg_class ic on ic.oid = x.indexrelid
      join pg_namespace n on n.oid = ic.relnamespace
     where n.nspname = 'public' and ic.relname = idx_name;
    if not found then
      raise exception 'FAIL (CHECK 16): index public.% is missing', idx_name;
    end if;
    if idx_kind = 'unique' and not is_unique then
      raise exception
        'FAIL (CHECK 16): index public.% exists but is not UNIQUE — the rule it enforces is gone',
        idx_name;
    end if;
  end loop;
  raise notice 'OK (CHECK 16): all % match/matchmaking indexes present', array_length(expected, 1);
end $$;

\echo '=== CHECK 17: app schema functions ==='
select p.proname, p.prosecdef as security_definer
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app' order by 1;
do $$
declare
  -- Every privileged path the server drives lives here. The invariant has three parts:
  --   1. each function still exists (a rename breaks apps/server silently until runtime);
  --   2. its SECURITY DEFINER flag is what it should be — losing DEFINER breaks the RPC,
  --      gaining it turns a helper into an escalation;
  --   3. no *other* SECURITY DEFINER function has appeared in app unreviewed.
  expected constant text[][] := array[
    ['append_match_action',         'definer'],
    ['assert_catalog_version',      'definer'],
    ['claim_ticket_pair',           'definer'],
    ['create_room',                 'definer'],
    ['end_match',                   'definer'],
    ['grant_cards',                 'definer'],
    ['grant_launch_collection',     'definer'],
    ['grant_launch_collection_all', 'definer'],
    ['handle_new_user',             'definer'],
    ['join_room',                   'definer'],
    ['live_matches',                'definer'],
    ['on_profile_activated',        'definer'],
    ['profile_is_active',           'definer'],
    ['reap_stale_matches',          'definer'],
    ['redeem_invite_code',          'definer'],
    ['resolve_deck',                'definer'],
    ['save_loadout',                'definer'],
    ['start_match',                 'definer'],
    -- 0007: the one write path for a saved deck and for a saved trio (R250, R252), DEFINER
    -- like every other write path here: they run as the owner whoever calls them, and only
    -- service_role may call them (02 CHECK 4 asserts a client cannot).
    ['upsert_deck',                 'definer'],
    ['upsert_trio',                 'definer'],
    ['catalog_version',             'invoker'],
    ['current_profile_id',          'invoker'],
    ['deny_row_mutation',           'invoker'],
    ['set_updated_at',              'invoker'],
    ['setting',                     'invoker']];
  fn_name  text;
  fn_kind  text;
  secdef   boolean;
  cfg      text[];
  known    text[] := '{}'::text[];
  stray    text;
  i int;
begin
  for i in 1 .. array_length(expected, 1) loop
    fn_name := expected[i][1];
    fn_kind := expected[i][2];
    known := known || fn_name;

    select p.prosecdef, p.proconfig into secdef, cfg
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app' and p.proname = fn_name;
    if not found then
      raise exception 'FAIL (CHECK 17): app.% is missing', fn_name;
    end if;
    if fn_kind = 'definer' and not secdef then
      raise exception
        'FAIL (CHECK 17): app.% lost SECURITY DEFINER — it runs as the caller and its writes will be refused',
        fn_name;
    end if;
    if fn_kind = 'invoker' and secdef then
      raise exception
        'FAIL (CHECK 17): app.% gained SECURITY DEFINER — a helper that runs with the owner is an escalation',
        fn_name;
    end if;
    -- A SECURITY DEFINER function without a pinned search_path is hijackable by any role
    -- that can create objects in a schema it resolves through. Every app.* function pins
    -- `search_path = ''` today; this keeps the next one honest.
    if not coalesce(cfg, '{}'::text[]) @> array['search_path=""'] then
      raise exception
        'FAIL (CHECK 17): app.% does not pin search_path (proconfig = %)',
        fn_name, coalesce(array_to_string(cfg, ','), '(none)');
    end if;
  end loop;

  select string_agg(p.proname, ', ' order by p.proname) into stray
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app' and p.prosecdef and p.proname <> all (known);
  if stray is not null then
    raise exception
      'FAIL (CHECK 17): unreviewed SECURITY DEFINER function(s) in app: % — add them here with the reason they need the owner',
      stray;
  end if;

  raise notice 'OK (CHECK 17): % app functions, flags and pinned search_path as expected',
    array_length(expected, 1);
end $$;

\echo '=== ALL CHECKS RAN ==='
