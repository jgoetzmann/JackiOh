-- ============================================================================
-- Migration 0011: Tutorial progress on the account
-- ============================================================================
-- Serves SPEC.md §9.10 ("Progress") and SPEC §11 R320-R322: which tutorial
-- lessons an active account has won, and its newest choice to hide or show
-- the lesson path, kept on the server as well as on the device (R294) so a
-- player who signs in on another device finds them there. The client merges
-- the two copies (R321); this file is the account's copy, and the one rule it
-- enforces is that the copy only ever grows:
--
--   * a write's lessons are UNIONED into the stored ones, so a stale device,
--     or one that never won a lesson, can never remove a completed lesson;
--   * a write's Hide/Show choice replaces the stored one only when it was made
--     strictly later, so "Show" on one device is not undone by an older "Hide"
--     arriving from another (R322).
--
-- Nothing here is a game rule: a lesson is a practice game and records no
-- result (R187). The server does not know the lessons either -- they are the
-- client's (apps/web/src/tutorial/lessons.ts) -- so an id is only checked for
-- its shape, and an id the client no longer lists is kept and ignored by it.
--
-- SPEC §9.1's trust model holds as for decks: the browser reads its own row
-- through the Data API and never writes one. It proposes its progress to the
-- server API (PUT /api/tutorial), which checks the body and calls
-- app.merge_tutorial_progress below as service_role.
--
-- Apply order: 0001 (`app.settings`, `app.setting`, `app.current_profile_id`,
-- `public.profiles`) -> ... -> 0010 -> 0011 (this file).
-- This file only ADDS objects. Safe to re-apply: create-if-not-exists,
-- create-or-replace, drop-policy-if-exists, and settings inserted with
-- ON CONFLICT DO NOTHING.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- public.tutorial_progress -- one row per profile (R320).
-- ----------------------------------------------------------------------------
-- `completed` is a text[] rather than jsonb because the one thing done to it
-- is a set union, which `unnest` and `distinct` say directly. It is kept
-- sorted in code-point order (`collate "C"`), so a row reads the same whatever
-- order its lessons were won in, and the server's in-memory stores sort the
-- same way.
--
-- `hidden` / `hidden_at` are the newest explicit choice and the instant it was
-- made (the choosing device's clock, never later than the server's when it
-- arrived: the server clamps it, R320). Both are NULL until the player first
-- hides or shows the path, and never one without the other.
create table if not exists public.tutorial_progress (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  completed  text[] not null default '{}',
  hidden     boolean,
  hidden_at  timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tutorial_progress_choice_pair_check check ((hidden is null) = (hidden_at is null)),
  constraint tutorial_progress_completed_no_null_check check (array_position(completed, null) is null)
);

comment on table public.tutorial_progress is
  $$SPEC §9.10 / R320: an active account's tutorial progress -- the lesson ids
  it has won and its newest Hide/Show choice. Grows only: written solely by
  app.merge_tutorial_progress (SECURITY DEFINER, service_role only), which
  unions the lessons and keeps the newest choice. A client reads its own row
  and writes none (SPEC §9.1).$$;

comment on column public.tutorial_progress.completed is
  $$R320: completed lesson ids, each once, in code-point order. Lower-case
  slugs of at most tutorial_lesson_id_max_length characters, at most
  tutorial_lessons_max of them. Never shrinks.$$;

comment on column public.tutorial_progress.hidden is
  $$R322: the newest explicit choice -- true "Hide tutorial", false "Show
  tutorial" -- or NULL before the first. Replaced only by a choice with a
  strictly later hidden_at (R320, R321).$$;

comment on column public.tutorial_progress.hidden_at is
  $$R320, R321: when `hidden` was chosen, by the choosing device's clock and
  never later than the server's when it arrived. NULL exactly when `hidden` is.$$;

alter table public.tutorial_progress enable row level security;

-- SPEC §9.1: a profile reads only its own row, exactly as decks and trios
-- (0007). No insert/update/delete policy exists for any client role: RLS
-- default deny is the enforcement for "no client-writable path", and the only
-- writer is the server.
drop policy if exists tutorial_progress_select_own on public.tutorial_progress;
create policy tutorial_progress_select_own
  on public.tutorial_progress
  for select
  to authenticated
  using (profile_id = app.current_profile_id());

-- ============================================================================
-- Server config the merge reads.
-- ============================================================================
-- These MIRROR apps/server/src/config.ts -- TUTORIAL_LESSONS_MAX (32) and
-- TUTORIAL_LESSON_ID_MAX_LENGTH (40), SPEC §11 R320 -- which is where the
-- server reads them. They are repeated here, as 0007 repeated the deck caps,
-- so the database refuses a malformed id or an overfull row even from a caller
-- that skipped the server's checks; the server passes its own cap to each
-- merge and the function applies the smaller of the two. Changing one of these
-- numbers for a deployment means config.ts AND a new migration updating the
-- row here.
insert into app.settings (key, value) values ('tutorial_lessons_max', to_jsonb(32))
on conflict (key) do nothing;

insert into app.settings (key, value) values ('tutorial_lesson_id_max_length', to_jsonb(40))
on conflict (key) do nothing;

-- ----------------------------------------------------------------------------
-- app.merge_tutorial_progress -- the one write path (R320).
-- ----------------------------------------------------------------------------
-- Merges one device's progress into the profile's row, creating it on the
-- first write, and returns what it did:
--   'merged' -- the row now holds the union of its lessons and p_completed,
--               and the newer of its choice and (p_hidden, p_hidden_at);
--   'limit'  -- the union would hold more than least(p_max,
--               tutorial_lessons_max) lessons; nothing written. Only a client
--               sending ids no lesson has can get here.
--
-- A choice replaces the stored one only when p_hidden_at is STRICTLY later: a
-- tie keeps what is stored, so the same write twice changes nothing (R321).
-- p_hidden and p_hidden_at are both NULL ("no choice to propose") or both set.
--
-- Under the profile row lock (`select ... for update`), so two writes for one
-- profile -- two devices finishing lessons at once -- run one after the other
-- and neither union can lose the other's lesson.
--
-- Like app.upsert_deck this is defense in depth, NOT the authority for what a
-- player reads: the server checks the body first (src/api/tutorial.ts) and
-- answers every malformed request itself. The shape checks below exist so no
-- admin tool or future endpoint can store an id the server would refuse; each
-- raises with a "tutorial:" prefix, which no player ever sees.
create or replace function app.merge_tutorial_progress(
  p_profile_id uuid,
  p_completed  text[],
  p_hidden     boolean,
  p_hidden_at  timestamptz,
  p_at         timestamptz,
  p_max        int
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status    text;
  v_id_max    int;
  v_cap       int;
  v_found     boolean;
  v_completed text[];
  v_hidden    boolean;
  v_hidden_at timestamptz;
  v_union     text[];
begin
  -- SPEC §9.4: a pending account has the code screen and nothing else, and the
  -- API route is `active` for the same reason. Checked against p_profile_id
  -- itself, as app.upsert_deck does, because the only caller is service_role,
  -- for whom auth.uid() means nothing. `for update` is the lock the merge runs
  -- under.
  select p.status into v_status
    from public.profiles p
   where p.id = p_profile_id
     for update;
  if not found then
    raise exception 'tutorial: profile % not found', p_profile_id;
  elsif v_status <> 'active' then
    raise exception 'tutorial: profile % is not active (status=%)', p_profile_id, v_status;
  end if;

  if p_completed is null then
    raise exception 'tutorial: p_completed must be an array of lesson ids';
  end if;
  if (p_hidden is null) <> (p_hidden_at is null) then
    raise exception 'tutorial: a choice needs both p_hidden and p_hidden_at';
  end if;
  v_id_max := (app.setting('tutorial_lesson_id_max_length'))::text::int;
  if exists (
    select 1 from unnest(p_completed) as c(lesson_id)
     where c.lesson_id is null
        or char_length(c.lesson_id) > v_id_max
        or c.lesson_id !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  ) then
    raise exception 'tutorial: every lesson id must be a lower-case slug of at most % characters', v_id_max;
  end if;

  select t.completed, t.hidden, t.hidden_at
    into v_completed, v_hidden, v_hidden_at
    from public.tutorial_progress t
   where t.profile_id = p_profile_id;
  v_found := found;

  -- R320: the union, each id once, in code-point order.
  v_union := array(
    select distinct u.lesson_id collate "C"
      from unnest(coalesce(v_completed, '{}'::text[]) || p_completed) as u(lesson_id)
     order by 1
  );
  v_cap := least(p_max, (app.setting('tutorial_lessons_max'))::text::int);
  if cardinality(v_union) > v_cap then
    return 'limit';
  end if;

  -- R320, R321: the newest explicit choice wins; a tie keeps the stored one.
  if p_hidden is not null and (v_hidden_at is null or p_hidden_at > v_hidden_at) then
    v_hidden := p_hidden;
    v_hidden_at := p_hidden_at;
  end if;

  if v_found then
    update public.tutorial_progress
       set completed = v_union,
           hidden = v_hidden,
           hidden_at = v_hidden_at,
           updated_at = p_at
     where profile_id = p_profile_id;
  else
    insert into public.tutorial_progress (profile_id, completed, hidden, hidden_at, created_at, updated_at)
    values (p_profile_id, v_union, v_hidden, v_hidden_at, p_at, p_at);
  end if;
  return 'merged';
end;
$$;

comment on function app.merge_tutorial_progress(uuid, text[], boolean, timestamptz, timestamptz, int) is
  $$R320: the one write path for tutorial progress. Unions p_completed into
  the profile's lessons and keeps the strictly newer Hide/Show choice,
  creating the row on the first write; returns 'merged', or 'limit' (the union
  would pass least(p_max, app.settings tutorial_lessons_max); nothing
  written). Under the profile row lock. Shape checks (an active profile, slug
  ids, a choice with its time) raise with a "tutorial:" prefix; the server
  checks first. service_role only.$$;

-- ============================================================================
-- Explicit grants (default-deny first: revoke everything, then grant back
-- only what SPEC §9.1 allows), exactly as 0007 did for decks.
-- ============================================================================
revoke all on public.tutorial_progress from public, anon, authenticated;
grant select on public.tutorial_progress to authenticated;

revoke all on function app.merge_tutorial_progress(uuid, text[], boolean, timestamptz, timestamptz, int) from public;
grant execute on function app.merge_tutorial_progress(uuid, text[], boolean, timestamptz, timestamptz, int) to service_role;

-- ----------------------------------------------------------------------------
-- Closing summary of what this schema lets each role do.
-- ----------------------------------------------------------------------------
-- anon:          nothing on tutorial_progress, and no EXECUTE on the merge.
-- authenticated: SELECT on tutorial_progress, filtered by RLS to the row where
--                profile_id = app.current_profile_id() -- its own progress
--                only. No INSERT, UPDATE or DELETE grant or policy and no
--                EXECUTE on app.merge_tutorial_progress: a client proposes its
--                progress to the server API, which checks it and calls the
--                merge.
-- service_role:  BYPASSRLS covers reads of the table directly (GET
--                /api/tutorial); app.merge_tutorial_progress is granted
--                EXECUTE explicitly, and every write goes through it.
-- ============================================================================
