// Deterministic cleanup for 99-online-smoke.cy.ts, and only for it.
//
// WHY THIS NEEDS THE DATABASE. The spec's second run failed where its first had passed, with
// `409 Conflict` on `POST /api/rooms`: the first run had left both accounts inside a live match,
// and `assertNotInMatch` then refuses every room and queue call. There is no HTTP way out — the
// route table has no leave-match or concede endpoint, so a match ends only through the WebSocket
// `concede` action, R79's clocks, or the reaper. Conceding over the socket needs the match id,
// and `/api/auth/me` does not return one, so a harness that has lost the match URL cannot even
// find the match it is stuck in.
//
// That is a gap in the product worth fixing separately. For the suite it means the only reliable
// reset is the one below.
//
// INERT WITHOUT `E2E_DATABASE_URL`. CI sets neither it nor `E2E_ONLINE`, so the spec is skipped
// there and this task is never called. Nothing here is reachable from the frozen M8 specs.

import { Client } from "pg";

export type OnlineResetResult = {
  ok: boolean;
  /** What was cleared, for the spec to log. */
  cleared?: { profiles: number; tickets: number; matches: number };
  skipped?: string;
  error?: string;
};

export async function onlineReset(): Promise<OnlineResetResult> {
  const connectionString = process.env["E2E_DATABASE_URL"];
  if (connectionString === undefined || connectionString === "") {
    return { ok: false, skipped: "E2E_DATABASE_URL is not set" };
  }

  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    // Order matters: `tickets.match_id` and `profiles.current_match_id` are foreign keys into
    // `matches`, so the references go before the rows they point at.
    const profiles = await client.query(
      "update public.profiles set current_match_id = null where current_match_id is not null",
    );
    await client.query("delete from public.match_actions");
    const tickets = await client.query("delete from public.tickets");
    const matches = await client.query("delete from public.matches");
    return {
      ok: true,
      cleared: {
        profiles: profiles.rowCount ?? 0,
        tickets: tickets.rowCount ?? 0,
        matches: matches.rowCount ?? 0,
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await client.end().catch(() => undefined);
  }
}
