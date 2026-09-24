// The runner's diff of two views (`newEventsSince`) against the real engine's redaction.
//
// Game hands the runner only the events a new view's window adds to the last one's (SPEC §10.8's
// window slides over the whole match). R97 redacts that window afresh for every view, judging each
// card by where it sits now, so an event both windows carry can read differently in each: the
// opponent's `drawn` names the card once they play it, a spell back in its owner's hand hides its
// `cardPlayed` from the other seat again. The diff used to compare the two copies byte for byte,
// found no overlap, and handed the runner the whole window, so every animation already played ran
// again before the new ones. Measured over real games before the fix: one seat-view in eight, nearly
// all of them the seat watching the other player act, which is every view practice and online play
// show during the opponent's turn.
//
// The games are real (`audio/test/realGame.ts`, through `engine.real.ts` as the client reaches the
// engine), the policy is a seeded random pick over `legalActions`, and every action is checked on
// both seats: the runner must be handed exactly the events that action produced, as the very
// objects the new view carries, and nothing it has already been given.

import { describe, expect, it } from "vitest";

import type { ActionBody, PlayerId, PlayerView } from "@jackioh/shared";

import { newEventsSince } from "./animations.ts";
import { devDeck, realGame } from "../audio/test/realGame.ts";

const GAMES = 10;
const MAX_ACTIONS = 140;
/** The sweep runs in about 1.5 s alone; the full suite's parallel load has measured over 8 s. */
const SWEEP_TIMEOUT_MS = 60_000;
/** How often the policy prefers a play, an attack or an answer over ending the turn. */
const ACT_BIAS = 0.85;

/** A seeded LCG: the policy is a test fixture, deterministic by seed. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** How many events the two windows share whose copies R97 has rewritten between them. */
function rewrittenInOverlap(before: PlayerView, after: PlayerView, produced: number): number {
  const shared = Math.min(before.events.length, after.events.length - produced);
  const tail = before.events.slice(before.events.length - shared);
  return tail.filter((event, i) => JSON.stringify(event) !== JSON.stringify(after.events[i])).length;
}

type Miss = { game: number; action: number; seat: PlayerId; produced: number; handed: number };

describe("newEventsSince against the engine's own views", () => {
  it("hands each seat's runner exactly the events each action produced, whatever R97 rewrote in the window", { timeout: SWEEP_TIMEOUT_MS }, () => {
    const misses: Miss[] = [];
    let rewritten = 0;
    let checked = 0;

    for (let g = 1; g <= GAMES; g += 1) {
      const rand = lcg(g);
      const game = realGame(`anim-window-${String(g)}`, [devDeck("cheap20"), devDeck(g % 2 === 0 ? "first20" : "cheap20")]);
      for (let action = 0; action < MAX_ACTIONS; action += 1) {
        const who = game.actor();
        if (who === null || game.view("p1").result !== null) break;
        const legal = game.legal(who).filter((a: ActionBody) => a.type !== "concede" && a.type !== "offerDraw");
        const acts = legal.filter((a) => a.type !== "endTurn");
        const pool = acts.length > 0 && rand() < ACT_BIAS ? acts : legal;
        const body = pool[Math.floor(rand() * pool.length)];
        if (body === undefined) break;

        const before = { p1: game.view("p1"), p2: game.view("p2") };
        const produced = game.act(who, body).length;
        for (const seat of ["p1", "p2"] as const) {
          const after = game.view(seat);
          const handed = newEventsSince(before[seat].events, after.events);
          const expected = after.events.slice(after.events.length - produced);
          checked += 1;
          rewritten += rewrittenInOverlap(before[seat], after, produced);
          if (handed.length !== expected.length || handed.some((event, i) => event !== expected[i])) {
            misses.push({ game: g, action, seat, produced, handed: handed.length });
          }
        }
      }
    }

    expect(checked, "views checked").toBeGreaterThan(GAMES * 20);
    expect(rewritten, "R97 rewrote events the windows shared, so the case is exercised").toBeGreaterThan(0);
    expect(misses.slice(0, 5), `${String(misses.length)} of ${String(checked)} views handed the runner the wrong events`).toEqual([]);
  });
});
