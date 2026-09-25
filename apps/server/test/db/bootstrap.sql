-- The Supabase-managed pieces the migrations assume, for a throwaway Postgres container.
-- Applied by test/db/run.sh BEFORE the migrations; never applied to a real project, where
-- Supabase provides all of it.
--
-- This is deliberately a second copy of `test/sql/00_supabase_stub.sql` (another agent's file)
-- plus the piece that file does not need: the PRIVILEGES Supabase grants `service_role`. The SQL
-- suite drives the database as `postgres` and as `authenticated`; the driver under test here runs
-- as `service_role`, which carries BYPASSRLS but NO table privileges of its own — table privileges
-- are checked before RLS, so without these grants every store call fails with
-- "permission denied for table profiles". Supabase's own bootstrap issues exactly these.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;

-- `SET ROLE` (and therefore `set_config('role', ...)`) needs the session user to be a member of
-- the target role. A superuser may switch regardless, but Supabase really does grant these to
-- `postgres`, and the store must work on a connection that is not a superuser.
grant anon, authenticated, service_role to current_user;

create schema if not exists auth;

create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text unique,
  email_confirmed_at timestamptz
);

-- Supabase's auth.uid() reads the request's JWT claims; this stub reads the GUC the driver sets
-- with `set_config('request.jwt.claim.sub', ..., true)` inside each transaction.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant select on auth.users to service_role;

-- What Supabase grants service_role in `public`. `alter default privileges` covers the tables the
-- migrations are about to create; test/db/grants.sql repeats it afterwards as a belt.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant all on functions to service_role;
