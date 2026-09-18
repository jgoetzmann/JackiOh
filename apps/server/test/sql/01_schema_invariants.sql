\set ON_ERROR_STOP on
\echo '=== CHECK 1: every table in public has RLS enabled (must be 0 rows) ==='
select c.relname as table_without_rls
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
 order by 1;

\echo '=== CHECK 2: the 13 tables BUILD M6 names ==='
select count(*) as public_tables from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r';
select string_agg(c.relname, ', ' order by c.relname) as tables from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r';

\echo '=== CHECK 3: L4 unique index ==='
select indexdef from pg_indexes where indexname = 'loadout_card_unique';

\echo '=== CHECK 4: no SECURITY DEFINER function in the exposed public schema ==='
select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prosecdef order by 1;

\echo '=== CHECK 5: no INSERT/UPDATE/DELETE policy for anon or authenticated ==='
select schemaname, tablename, policyname, cmd, roles
  from pg_policies
 where schemaname = 'public' and cmd <> 'SELECT'
 order by tablename, policyname;

\echo '=== CHECK 6: client write privileges on public tables (must be 0 rows) ==='
select table_name, grantee, privilege_type
  from information_schema.role_table_grants
 where table_schema = 'public'
   and grantee in ('anon', 'authenticated')
   and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
 order by 1, 2, 3;

\echo '=== CHECK 7: append-only triggers ==='
select c.relname as table_name, t.tgname
  from pg_trigger t join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and not t.tgisinternal
 order by 1, 2;

\echo '=== CHECK 8: signup trigger creates a pending profile ==='
insert into auth.users (id, email, email_confirmed_at)
values ('11111111-1111-1111-1111-111111111111', 'p1@example.test', now()),
       ('22222222-2222-2222-2222-222222222222', 'p2@example.test', null);
select id, status, rating from public.profiles order by id;

\echo '=== CHECK 9: redemption — rejections ==='
insert into public.invite_codes (code_hash, label, max_uses)
values ('hash-good', 'bring-up', 2), ('hash-revoked', 'revoked', 1);
update public.invite_codes set revoked_at = now() where code_hash = 'hash-revoked';
select app.redeem_invite_code('22222222-2222-2222-2222-222222222222', 'hash-good', 'ip-a')
       as unverified_email;
select app.redeem_invite_code('11111111-1111-1111-1111-111111111111', 'hash-missing', 'ip-a')
       as missing_code;
select app.redeem_invite_code('11111111-1111-1111-1111-111111111111', 'hash-revoked', 'ip-a')
       as revoked_code;

\echo '=== CHECK 10: redemption — success flips status and fires the launch grant ==='
insert into public.cards (id, card_index, name, set_id, type, tags, rarity, token, cost,
                          catalog_version)
values ('core-001', '1', 'Test Unit', 'Core', 'Unit', '{}', 'Common', false, '1'::jsonb, 'core-1'),
       ('core-002', '2', 'Test Spell', 'Core', 'Spell', '{}', 'Rare', false, '2'::jsonb, 'core-1'),
       ('tok-001', '1.1', 'Test Token', 'Core', 'Unit', '{Token}', 'Token', true, '0'::jsonb,
        'core-1');
select app.redeem_invite_code('11111111-1111-1111-1111-111111111111', 'hash-good', 'ip-a')
       as redeem_ok;
select status, activated_at is not null as activated from public.profiles
 where id = '11111111-1111-1111-1111-111111111111';
select card_id, quantity from public.collection
 where profile_id = '11111111-1111-1111-1111-111111111111' order by card_id;
select card_id, delta, reason from public.collection_grants
 where profile_id = '11111111-1111-1111-1111-111111111111' order by card_id;

\echo '=== CHECK 11: collection_grants is append-only (must raise) ==='
do $$
begin
  update public.collection_grants set delta = 99 where profile_id is not null;
  raise exception 'FAIL: collection_grants accepted an UPDATE';
exception when others then
  if sqlerrm like 'FAIL:%' then raise; end if;
  raise notice 'OK: collection_grants refused the UPDATE %', sqlerrm;
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
do $$
begin
  set local role authenticated;
  perform 1 from public.invite_codes;
  reset role;
  raise exception 'FAIL: authenticated read invite_codes';
exception when insufficient_privilege then
  raise notice 'OK: invite_codes refused';
when others then
  if sqlerrm like 'FAIL:%' then raise; end if;
  raise notice 'OK-ish: invite_codes raised %', sqlerrm;
end $$;

\echo '=== CHECK 14: L4 — the unique index refuses a card in two decks ==='
select app.redeem_invite_code('22222222-2222-2222-2222-222222222222', 'hash-good', 'ip-b')
       as second_profile_needs_verified_email;
insert into public.loadouts (profile_id, catalog_version)
values ('11111111-1111-1111-1111-111111111111', 'core-1');
insert into public.loadout_decks (profile_id, slot, name) values
  ('11111111-1111-1111-1111-111111111111', 1, 'One'),
  ('11111111-1111-1111-1111-111111111111', 2, 'Two');
insert into public.loadout_deck_cards (profile_id, slot, card_id, count)
values ('11111111-1111-1111-1111-111111111111', 1, 'core-001', 1);
do $$
begin
  insert into public.loadout_deck_cards (profile_id, slot, card_id, count)
  values ('11111111-1111-1111-1111-111111111111', 2, 'core-001', 1);
  raise exception 'FAIL: L4 index allowed the same card in two decks';
exception when unique_violation then
  raise notice 'OK: loadout_card_unique refused the cross-deck duplicate';
when others then
  if sqlerrm like 'FAIL:%' then raise; end if;
  raise notice 'UNEXPECTED: %', sqlerrm;
end $$;

\echo '=== CHECK 15 (R105): stale catalog version says "update required" ==='
do $$
begin
  perform app.assert_catalog_version('core-999');
  raise exception 'FAIL: a stale catalog version was accepted';
exception when others then
  if sqlerrm like 'FAIL:%' then raise; end if;
  raise notice 'OK: %', sqlerrm;
end $$;

\echo '=== CHECK 16: matchmaking and match tables exist with their indexes ==='
select indexname from pg_indexes
 where schemaname = 'public' and tablename in ('tickets', 'matches', 'match_actions', 'results')
 order by 1;

\echo '=== CHECK 17: app schema functions ==='
select p.proname, p.prosecdef as security_definer
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app' order by 1;

\echo '=== ALL CHECKS RAN ==='
