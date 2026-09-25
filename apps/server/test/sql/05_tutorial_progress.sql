-- Tutorial progress on the account (migration 0011, SPEC §9.10, R320), as the server
-- (postgres/service_role) drives it. Runs after 04_decks_and_series.sql; profiles 1, 2 and 3 are
-- active by then (03 activated them).
\set ON_ERROR_STOP on

-- Same rules as 01-04 (see 03's header for why each one exists):
--
--   * a check FAILS LOUDLY: every heading's assertion is a `do $$ ... raise exception
--     'FAIL (R320): ...' $$` block, never a printed row a human has to read;
--   * a `when others` handler is never the proof: every expected refusal is matched on its exact
--     message prefix, or on the constraint name read with GET STACKED DIAGNOSTICS;
--   * a check that could be trivially true carries a vacuity guard (a successful control before
--     each refusal, a row to find before a comparison).
--
-- Each SPEC §11 row this file proves is named in a `### Rnnn: … ###` heading, which is how the
-- §11 index (packages/engine/test/rulings.test.ts) credits an SQL file. What a CLIENT may do with
-- the table — read its own row, write none, not call the merge — is 02_rls_as_client.sql's R320
-- block. Everything here runs inside a transaction that is rolled back.

\echo '### R320: app.merge_tutorial_progress unions the lessons, keeps the strictly newer choice and caps the row ###'
begin;
do $$
declare
  p1 constant uuid := '11111111-1111-1111-1111-111111111111';
  p2 constant uuid := '22222222-2222-2222-2222-222222222222';
  t0 constant timestamptz := '2026-01-01 00:00:00+00';
  t1 constant timestamptz := '2026-01-01 00:01:00+00';
  t2 constant timestamptz := '2026-01-01 00:02:00+00';
  r     text;
  v_row record;
begin
  -- The two app.settings rows 0011 seeds mirror apps/server/src/config.ts.
  if (app.setting('tutorial_lessons_max'))::text::int <> 32
     or (app.setting('tutorial_lesson_id_max_length'))::text::int <> 40 then
    raise exception 'FAIL (R320): app.settings holds % lessons / % id characters, expected 32 / 40 as config.ts',
      app.setting('tutorial_lessons_max'), app.setting('tutorial_lesson_id_max_length');
  end if;
  if exists (select 1 from public.tutorial_progress where profile_id in (p1, p2)) then
    raise exception 'FAIL (R320): profiles 1 and 2 already hold tutorial rows, so the checks below are off';
  end if;

  -- The first write makes the row: each id once, in code-point order. `first-steps` sorts before
  -- `firsts` only by code point ('-' < 's'); a collation that skips punctuation would put it after.
  r := app.merge_tutorial_progress(p1, '{spells,firsts,first-steps,basics,spells}', null, null, t0, 32);
  if r <> 'merged' then
    raise exception 'FAIL (R320): the first write answered %, expected merged', r;
  end if;
  select * into v_row from public.tutorial_progress where profile_id = p1;
  if v_row.completed <> '{basics,first-steps,firsts,spells}'::text[]
     or v_row.hidden is not null or v_row.hidden_at is not null
     or v_row.created_at <> t0 or v_row.updated_at <> t0 then
    raise exception 'FAIL (R320): the first write reads back as %', v_row;
  end if;

  -- A stale device (fewer lessons) or an empty one takes nothing away; a new lesson joins.
  perform app.merge_tutorial_progress(p1, '{basics}', null, null, t1, 32);
  perform app.merge_tutorial_progress(p1, '{}', null, null, t1, 32);
  perform app.merge_tutorial_progress(p1, '{traps}', null, null, t2, 32);
  select * into v_row from public.tutorial_progress where profile_id = p1;
  if v_row.completed <> '{basics,first-steps,firsts,spells,traps}'::text[] then
    raise exception 'FAIL (R320): after a stale, an empty and a new write the lessons read %', v_row.completed;
  end if;
  if v_row.created_at <> t0 or v_row.updated_at <> t2 then
    raise exception 'FAIL (R320): created_at must stay % and updated_at move to %, read % / %',
      t0, t2, v_row.created_at, v_row.updated_at;
  end if;

  -- The newest choice wins; an older one never replaces it; a tie keeps the stored one; a write
  -- with no choice leaves it alone.
  perform app.merge_tutorial_progress(p1, '{}', true, t0, t2, 32);
  perform app.merge_tutorial_progress(p1, '{}', false, t1, t2, 32);
  perform app.merge_tutorial_progress(p1, '{}', true, t0, t2, 32);
  perform app.merge_tutorial_progress(p1, '{}', true, t1, t2, 32);
  perform app.merge_tutorial_progress(p1, '{}', null, null, t2, 32);
  select * into v_row from public.tutorial_progress where profile_id = p1;
  if v_row.hidden is distinct from false or v_row.hidden_at is distinct from t1 then
    raise exception 'FAIL (R320): Hide at %, Show at %, then older and tied Hides: the choice reads % at %, expected false at %',
      t0, t1, v_row.hidden, v_row.hidden_at, t1;
  end if;

  -- The cap: the caller's, counted over the union, and nothing written past it.
  r := app.merge_tutorial_progress(p2, '{basics,spells}', null, null, t0, 3);
  if r <> 'merged' then
    raise exception 'FAIL (R320): two lessons under a cap of 3 answered %', r;
  end if;
  r := app.merge_tutorial_progress(p2, '{traps,advanced}', true, t1, t1, 3);
  if r <> 'limit' then
    raise exception 'FAIL (R320): a union of 4 under a cap of 3 answered %, expected limit', r;
  end if;
  select * into v_row from public.tutorial_progress where profile_id = p2;
  if v_row.completed <> '{basics,spells}'::text[] or v_row.hidden is not null then
    raise exception 'FAIL (R320): a write refused at the cap still changed the row: %', v_row;
  end if;
  if app.merge_tutorial_progress(p2, '{traps}', null, null, t1, 3) <> 'merged' then
    raise exception 'FAIL (R320): a union of exactly 3 under a cap of 3 was refused';
  end if;

  -- The database's own cap, when the caller asks for more than app.settings allows.
  update app.settings set value = to_jsonb(3) where key = 'tutorial_lessons_max';
  r := app.merge_tutorial_progress(p2, '{advanced}', null, null, t2, 32);
  update app.settings set value = to_jsonb(32) where key = 'tutorial_lessons_max';
  if r <> 'limit' then
    raise exception 'FAIL (R320): with app.settings at 3 and the caller at 32 a fourth lesson answered %, expected limit', r;
  end if;

  -- Each profile's row is its own.
  if (select completed from public.tutorial_progress where profile_id = p1)
     <> '{basics,first-steps,firsts,spells,traps}'::text[] then
    raise exception 'FAIL (R320): profile 2''s writes changed profile 1''s row';
  end if;

  raise notice 'OK (R320): created sorted in code-point order, unioned (stale, empty and new writes), newest choice kept (older and tie refused), limit at both caps, rows apart';
end $$;
rollback;

\echo '-- the shape app.merge_tutorial_progress and the table refuse (the server refuses it first)'
begin;
do $$
declare
  -- [label, call, expected message prefix]
  probes constant text[][] := array[
    ['an upper-case id',
     $q$select app.merge_tutorial_progress('11111111-1111-1111-1111-111111111111', '{Basics}', null, null, now(), 32)$q$,
     'tutorial: every lesson id must be a lower-case slug'],
    ['a 41-character id',
     $q$select app.merge_tutorial_progress('11111111-1111-1111-1111-111111111111', array[repeat('a', 41)], null, null, now(), 32)$q$,
     'tutorial: every lesson id must be a lower-case slug'],
    ['an id with a space',
     $q$select app.merge_tutorial_progress('11111111-1111-1111-1111-111111111111', '{"a b"}', null, null, now(), 32)$q$,
     'tutorial: every lesson id must be a lower-case slug'],
    ['a null id',
     $q$select app.merge_tutorial_progress('11111111-1111-1111-1111-111111111111', array[null]::text[], null, null, now(), 32)$q$,
     'tutorial: every lesson id must be a lower-case slug'],
    ['no lesson list at all',
     $q$select app.merge_tutorial_progress('11111111-1111-1111-1111-111111111111', null, null, null, now(), 32)$q$,
     'tutorial: p_completed must be an array'],
    ['a choice with no time',
     $q$select app.merge_tutorial_progress('11111111-1111-1111-1111-111111111111', '{}', true, null, now(), 32)$q$,
     'tutorial: a choice needs both'],
    ['a time with no choice',
     $q$select app.merge_tutorial_progress('11111111-1111-1111-1111-111111111111', '{}', null, now(), now(), 32)$q$,
     'tutorial: a choice needs both'],
    ['a profile that does not exist',
     $q$select app.merge_tutorial_progress('99999999-9999-4999-8999-999999999999', '{}', null, null, now(), 32)$q$,
     'tutorial: profile 99999999-9999-4999-8999-999999999999 not found']];
  refused_by text;
  i int;
begin
  -- Vacuity guard: the same call with a well-formed body succeeds, so each refusal below is about
  -- the one thing its probe changed.
  if app.merge_tutorial_progress('11111111-1111-1111-1111-111111111111', '{basics,first-steps}', true, now(), now(), 32)
     <> 'merged' then
    raise exception 'FAIL (R320): the control write was not merged, so the refusals below prove nothing';
  end if;
  delete from public.tutorial_progress where profile_id = '11111111-1111-1111-1111-111111111111';

  for i in 1 .. array_length(probes, 1) loop
    begin
      execute probes[i][2];
      raise exception 'FAIL (R320): % was merged — app.merge_tutorial_progress must refuse it', probes[i][1];
    exception when others then
      if sqlerrm like 'FAIL%' then raise; end if;
      if sqlerrm not like probes[i][3] || '%' then
        raise exception 'FAIL (R320): % raised "%" (%), expected a message starting "%"',
          probes[i][1], sqlerrm, sqlstate, probes[i][3];
      end if;
    end;
  end loop;
  if exists (select 1 from public.tutorial_progress where profile_id = '11111111-1111-1111-1111-111111111111') then
    raise exception 'FAIL (R320): a refused write left a row behind';
  end if;

  -- The table holds the same line without the function: a choice is both columns or neither, and
  -- no lesson is null.
  begin
    insert into public.tutorial_progress (profile_id, hidden) values ('11111111-1111-1111-1111-111111111111', true);
    raise exception 'FAIL (R320): a raw row held a choice with no time';
  exception
    when check_violation then
      get stacked diagnostics refused_by = constraint_name;
      if refused_by is distinct from 'tutorial_progress_choice_pair_check' then
        raise exception 'FAIL (R320): the half choice was refused by "%", not tutorial_progress_choice_pair_check', refused_by;
      end if;
  end;
  begin
    insert into public.tutorial_progress (profile_id, completed)
    values ('11111111-1111-1111-1111-111111111111', array['basics', null]);
    raise exception 'FAIL (R320): a raw row held a null lesson';
  exception
    when check_violation then
      get stacked diagnostics refused_by = constraint_name;
      if refused_by is distinct from 'tutorial_progress_completed_no_null_check' then
        raise exception 'FAIL (R320): the null lesson was refused by "%", not tutorial_progress_completed_no_null_check', refused_by;
      end if;
  end;

  raise notice 'OK (R320): upper case, too long, a space, a null id, no list, a half choice and an unknown profile refused; the table refuses a half choice and a null lesson';
end $$;
rollback;

\echo '-- a profile that is not active keeps no tutorial progress on the account (rolled back)'
begin;
insert into auth.users (id, email, email_confirmed_at)
values ('66666666-6666-6666-6666-666666666666', 'pending-tutorial@example.test', now());
do $$
begin
  if (select status from public.profiles where id = '66666666-6666-6666-6666-666666666666') <> 'pending' then
    raise exception 'FAIL (R320): profile 6 is not pending, so the gate below is not exercised';
  end if;
  perform app.merge_tutorial_progress('66666666-6666-6666-6666-666666666666', '{basics}', null, null, now(), 32);
  raise exception 'FAIL (R320): a pending profile wrote tutorial progress — §9.4 gives it nothing but the code screen';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  if sqlerrm not like 'tutorial: profile % is not active (status=pending)' then
    raise exception 'FAIL (R320): the pending profile was refused with "%" (%), not the active-profile gate',
      sqlerrm, sqlstate;
  end if;
  raise notice 'OK (R320): %', sqlerrm;
end $$;
rollback;

\echo '### ALL TUTORIAL PROGRESS CHECKS RAN ###'
