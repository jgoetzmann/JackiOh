-- R254's input: a loadout saved the way the server saved one before migration 0007.
--
-- run.sh applies this AFTER migrations 0001-0006 and BEFORE 0007-0010, which is the moment a
-- real database that predates the decks meets 0007: its loadouts exist, public.decks does not.
-- 0007's data migration then turns this loadout into three decks and one trio, and
-- 04_decks_and_series.sql checks what it made.
--
-- Everything here is chosen so the loadout is distinguishable from anything 0007 could have
-- invented, and so it disturbs nothing 01-03 measure:
--
--   * its own profile, 44444444-…: 01 signs up 11111111-… and 22222222-…, 03 signs up
--     33333333-…, and 01's CHECK 8/9 count only their own two;
--   * its own catalog version, 'core-0', with its own 60 cards (legacy-001..legacy-060). The
--     launch grant and 03's CHECK 2 both count the CURRENT version's cards, 'core-1', so a legacy
--     card is never granted to profile 1 and never counted into 03's catalog of 60. It also
--     proves 0007 copies the loadout's version rather than stamping today's. app.catalog_version()
--     is switched to 'core-0' only while the loadout is saved, and switched back at the end;
--   * decks whose slot order is not their card order (slot 1 holds legacy-041..060), with the
--     cards handed to app.save_loadout in reverse, so "cards in app.resolve_deck order" and "the
--     trio holds them in slot order" are two different facts 04 can tell apart;
--   * a third name with padding and a double space, which 0007 must normalise the way
--     @jackioh/validator's normalizeName does.
\set ON_ERROR_STOP on

\echo '--- 03b: seeding a loadout saved before 0007 ---'

do $$
begin
  -- Vacuity guard for the whole R254 check: if public.decks already existed, 0007 has run
  -- already and this loadout would be converted by nothing.
  if to_regclass('public.decks') is not null then
    raise exception 'FAIL (03b): public.decks already exists — this seed must run before migration 0007';
  end if;
  if to_regclass('public.loadouts') is null then
    raise exception 'FAIL (03b): public.loadouts does not exist — migration 0003 has not run';
  end if;
end $$;

insert into auth.users (id, email, email_confirmed_at)
values ('44444444-4444-4444-4444-444444444444', 'legacy@example.test', now());

-- The version the loadout was saved against. Stashed first, so the restore below puts back
-- whatever 0001 seeded rather than a second copy of the literal.
select set_config('legacy.catalog_version', app.catalog_version(), false) \gset
update app.settings set value = to_jsonb('core-0'::text) where key = 'catalog_version';

insert into public.cards (id, card_index, name, set_id, type, tags, rarity, token, cost,
                          catalog_version)
select format('legacy-%s', to_char(n, 'FM000')), n::text, format('Legacy %s', n), 'Core',
       'Unit', '{}'::text[], 'Common', false, to_jsonb(1), 'core-0'
  from generate_series(1, 60) as n;

-- A real activation, as seed-accounts.ts makes one: the pending -> active transition fires
-- 0002's launch grant, which gives the profile the 60 'core-0' cards L5 needs.
update public.profiles set status = 'active', activated_at = now()
 where id = '44444444-4444-4444-4444-444444444444';

select app.save_loadout(
  '44444444-4444-4444-4444-444444444444',
  'core-0',
  jsonb_build_array(
    jsonb_build_object('name', 'Aggro', 'cards',
      (select jsonb_agg(jsonb_build_object('card_id', format('legacy-%s', to_char(n, 'FM000')), 'count', 1)
                        order by n desc)
         from generate_series(41, 60) as n)),
    jsonb_build_object('name', 'Control', 'cards',
      (select jsonb_agg(jsonb_build_object('card_id', format('legacy-%s', to_char(n, 'FM000')), 'count', 1)
                        order by n desc)
         from generate_series(1, 20) as n)),
    jsonb_build_object('name', '  Tempo   Deck ', 'cards',
      (select jsonb_agg(jsonb_build_object('card_id', format('legacy-%s', to_char(n, 'FM000')), 'count', 1)
                        order by n desc)
         from generate_series(21, 40) as n))
  )
) \gset

update app.settings set value = to_jsonb(current_setting('legacy.catalog_version'))
 where key = 'catalog_version';

do $$
declare
  legacy constant uuid := '44444444-4444-4444-4444-444444444444';
  n bigint;
begin
  if app.catalog_version() is distinct from 'core-1' then
    raise exception 'FAIL (03b): app.catalog_version() is % after the seed, expected core-1 back',
      app.catalog_version();
  end if;
  select count(*) into n from public.loadouts where profile_id = legacy and catalog_version = 'core-0';
  if n <> 1 then
    raise exception 'FAIL (03b): % legacy loadout row(s), expected 1 saved against core-0', n;
  end if;
  select count(*) into n from public.loadout_decks where profile_id = legacy;
  if n <> 3 then
    raise exception 'FAIL (03b): % legacy deck row(s), expected 3', n;
  end if;
  select count(*) into n from public.loadout_deck_cards where profile_id = legacy;
  if n <> 60 then
    raise exception 'FAIL (03b): % legacy card row(s), expected 60', n;
  end if;
  raise notice 'OK (03b): profile 4 holds a core-0 loadout of 3 decks x 20 cards for 0007 to convert';
end $$;
