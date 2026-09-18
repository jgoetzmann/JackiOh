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
set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
select count(*) as own_profile_rows from public.profiles;
select count(*) as own_collection_rows from public.collection;
select count(*) as visible_cards from public.cards;
reset role;

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
