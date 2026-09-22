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
// IT ENDS MATCHES, IT DOES NOT DELETE THEM. The first version deleted from `match_actions` and
// the database refused: "append-only table public.match_actions may not be updated or deleted".
// That guard is SPEC §9.3 — `(seed, log)` IS the truth of a match, so the log cannot be rewritten,
// and `matches` cannot be deleted either once rows reference it. An earlier hand-run of the same
// DELETE appeared to work only because the table was empty, so it touched no rows and the trigger
// never fired.
//
// So the reset goes through `app.end_match`, which migration 0004 calls "the one path that
// terminates a match" and which is idempotent by design (§9.5's reaper and a client ending could
// race). The reason is `match-ceiling` — one of the seven `results_reason_check` allows, and the
// honest one for a match nobody finished, since §9.5 makes the ceiling a draw. Ratings are passed
// back unchanged so a reset cannot move anyone's Elo.
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
    // 1. End every unfinished match through the sanctioned path. `end_match` clears both
    //    players' `current_match_id` itself (§9.5: "every ending ... clears both players'
    //    in-match state"), which is the whole point of using it rather than a bare UPDATE.
    const live = await client.query<{ id: string; p1: string | null; p2: string | null }>(
      `select m.id, m.p1_profile_id as p1, m.p2_profile_id as p2
         from public.matches m
        where m.status <> 'over'`,
    );
    let ended = 0;
    for (const row of live.rows) {
      // An UNCLAIMED ROOM cannot go through `end_match`, and that is a defect rather than a
      // quirk: the function sets `status = 'over'` while `p2_profile_id` is still null, which
      // `matches_p2_required_when_not_open_check` rejects —
      //   new row for relation "matches" violates check constraint
      //   "matches_p2_required_when_not_open_check"
      // — so a room nobody joined can never be terminated by the sanctioned path, and §9.5's
      // reaper hits the same wall. Such a row has no `match_actions` (nothing was played), so
      // nothing append-only protects it and deleting it is safe here.
      if (row.p2 === null) {
        await client.query("delete from public.matches where id = $1::uuid and p2_profile_id is null", [
          row.id,
        ]);
        ended += 1;
        continue;
      }
      const ratings = await client.query<{ rating: number }>(
        "select rating from public.profiles where id = any($1::uuid[])",
        [[row.p1, row.p2].filter((id): id is string => id !== null)],
      );
      const p1Rating = ratings.rows[0]?.rating ?? 1000;
      const p2Rating = ratings.rows[1]?.rating ?? p1Rating;
      // No winner: a draw, so neither rating is meant to move, and passing the current values
      // back is how `end_match` is told that.
      await client.query("select app.end_match($1::uuid, null, 'match-ceiling', 0, $2::int, $3::int)", [
        row.id,
        p1Rating,
        p2Rating,
      ]);
      ended += 1;
    }

    // 2. Any straggler still pointing at a match `end_match` did not own.
    const profiles = await client.query(
      "update public.profiles set current_match_id = null where current_match_id is not null",
    );

    // 3. Tickets carry no append-only guard; a stale one would keep the matchmaker busy.
    const tickets = await client.query("delete from public.tickets");

    return {
      ok: true,
      cleared: {
        profiles: profiles.rowCount ?? 0,
        tickets: tickets.rowCount ?? 0,
        matches: ended,
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await client.end().catch(() => undefined);
  }
}
