-- Applied by test/db/run.sh AFTER the four migrations, mirroring the privileges a Supabase
-- project gives `service_role`. `alter default privileges` in bootstrap.sql already covers every
-- table the migrations create; this repeats it explicitly so a table created some other way (a
-- future migration run by another role, say) cannot silently leave the server without access.
--
-- Nothing here weakens what the migrations decided: they revoke from `public`, `anon` and
-- `authenticated` only, and never mention service_role.

grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant usage on schema app to service_role;
