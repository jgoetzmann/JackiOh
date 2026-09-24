-- ============================================================================
-- 0006 — §9.4 step 3's per-IP window holds under concurrency
-- ============================================================================
-- app.redeem_invite_code (0001 §6) counted this IP hash's attempts at step 3
-- and logged the new one at step 4 with nothing between them held across
-- profiles: `for update of p` locks the caller's own profile row and nothing
-- else. So concurrent redemptions from DIFFERENT pending profiles at ONE
-- address all read the same count and all passed. Measured against
-- postgres:16 before this migration: with the address at exactly 20 attempts
-- in the window, 10 concurrent redemptions from 10 new profiles made 7 to 9
-- lookups where §9.4 allows one ("reject if this IP hash made more than 20").
--
-- The fix is one line, added before step 3's count: a transaction-scoped
-- advisory lock keyed on the IP hash, so redemptions from one address run one
-- at a time through steps 3 and 4 while redemptions from different addresses
-- still run side by side. The rest of the function is 0001's, unchanged; it is
-- restated whole because a function body cannot be patched in place. The
-- proving test is test/db/redeem-race.ts ("at the per-IP boundary"), run
-- against Postgres by `pnpm test:db`.
--
-- The circuit breaker's system-wide failure count is read the same unlocked
-- way. It is left so on purpose: it is a monitoring threshold (R106), a burst
-- can overshoot it by at most the number of redemptions in flight at once, and
-- serialising every redemption in the system to make it exact would let one
-- address's flood queue everybody else's.

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
  -- The count and step 4's insert below must not interleave with another
  -- redemption from the same IP hash, or every concurrent caller reads the
  -- same count and all of them pass. The profile row lock above does not
  -- cover it (different profiles, one address), so this takes a
  -- transaction-scoped advisory lock on the IP hash first, released when the
  -- transaction ends. Locks are always taken profile, then IP, then code, so
  -- two redemptions can never wait on each other in a cycle. (Migration 0006.)
  perform pg_advisory_xact_lock(hashtextextended('code_attempts:ip:' || p_ip_hash, 0));

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

-- Only the server calls this, as 0001 granted it: re-created, the function
-- keeps its grants, and restating them keeps this file whole on its own.
revoke execute on function app.redeem_invite_code(uuid, text, text) from public;
grant execute on function app.redeem_invite_code(uuid, text, text) to service_role;
