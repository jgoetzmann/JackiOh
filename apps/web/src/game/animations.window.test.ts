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
//
// R318's sweep does the same over games built to reach §2.4's three overflows, which the dev decks
// rarely do: a seat with a short deck fatigues, a seat with extra draws fills its hand and burns, and
// a seat whose deck is R80's cap plays #33 Unstable Clone Machine until its library turns copies
// away. Each of `fatigue`, `burned` and `libraryOverflow` must reach both seats' runners, once each.

import { describe, expect, it } from "vitest";

import { DECK_SIZE, HUMAN_HANDICAP, LIBRARY_CAP, type Handicap } from "@jackioh/engine/config";
import type { ActionBody, CardDef, GameEventType, PlayerId, PlayerView } from "@jackioh/shared";

import { newEventsSince } from "./animations.ts";
import { byIndex, printedCost } from "./decks.ts";
import { devDeck, handDefId, realGame, realPort, type RealGame } from "../audio/test/realGame.ts";

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

/* ------------------------------------------------------------------------------------------- *
 * R318: the three overflows, each handed to each seat's runner once
 * ------------------------------------------------------------------------------------------- */

const OVERFLOWS: readonly GameEventType[] = ["fatigue", "burned", "libraryOverflow"];
/** #33 Unstable Clone Machine: after its controller plays a card, three copies go into the library. */
const CLONE_MACHINE = "core-033";
/** #90 CN-Viral Injection: a CN-Virus into the opponent's library. */
const VIRAL_INJECTION = "core-090";

/** `n` distinct deckable ids, cheapest first (as `cheap20` picks them), after the ones a game needs. */
function cheapest(n: number, needs: readonly string[] = []): string[] {
  const catalog = realPort().catalog?.() ?? {};
  const pool = Object.values(catalog)
    .filter((def: CardDef) => !def.token && !def.tags.includes("Token"))
    .sort(byIndex)
    .sort((a, b) => printedCost(a.cost) - printedCost(b.cost));
  const deck = [...needs];
  for (const def of pool) if (deck.length < n && !deck.includes(def.id)) deck.push(def.id);
  return deck;
}

type OverflowGame = { label: string; game: () => RealGame; seed: number; prefer: readonly string[]; maxActions: number };

/**
 * The games (R180 handicaps, validated by the engine): p1 draws three a turn from 30 cards with a
 * nine-card opening hand, so its hand fills and burns, while p2's 6-card deck runs dry and fatigues;
 * and p1's 60-card deck (R80's cap, #33 and #90 in it) plays #33 whenever it can, so its library
 * reaches the cap and refuses the copies. The seeds were picked to reach them within the caps.
 */
function overflowGames(): OverflowGame[] {
  const burner: Handicap = { ...HUMAN_HANDICAP, deckSize: 30, extraOpeningCards: 6, extraDrawsPerTurn: 2 };
  const short: Handicap = { ...HUMAN_HANDICAP, deckSize: 6 };
  const capped: Handicap = { ...HUMAN_HANDICAP, deckSize: LIBRARY_CAP };
  const games: OverflowGame[] = [];
  for (const seed of [1, 2]) {
    games.push({
      label: `hand-${String(seed)}`,
      game: () => realGame(`overflow-hand-${String(seed)}`, [cheapest(30), cheapest(short.deckSize)], { p1: burner, p2: short }),
      seed,
      prefer: [],
      maxActions: 80,
    });
  }
  for (const seed of [12, 19, 33, 43, 57]) {
    games.push({
      label: `library-${String(seed)}`,
      game: () =>
        realGame(
          `overflow-lib-${String(seed)}`,
          [cheapest(LIBRARY_CAP, [CLONE_MACHINE, VIRAL_INJECTION]), cheapest(DECK_SIZE, [VIRAL_INJECTION])],
          { p1: capped },
        ),
      seed,
      prefer: [CLONE_MACHINE, VIRAL_INJECTION],
      maxActions: 100,
    });
  }
  return games;
}

describe("R318 the overflow events against the engine's own views", () => {
  it("R318 hands each seat's runner every fatigue, burn and full-library refusal exactly once, as each action produced it", { timeout: SWEEP_TIMEOUT_MS }, () => {
    const misses: (Miss & { label: string })[] = [];
    const seen: Record<PlayerId, Set<GameEventType>> = { p1: new Set(), p2: new Set() };
    const handed: Record<string, number> = {};
    const produced: Record<string, number> = {};

    for (const setup of overflowGames()) {
      const rand = lcg(setup.seed);
      const game = setup.game();
      for (let action = 0; action < setup.maxActions; action += 1) {
        const who = game.actor();
        if (who === null || game.view("p1").result !== null) break;
        const legal = game.legal(who).filter((a: ActionBody) => a.type !== "concede" && a.type !== "offerDraw");
        const wanted = legal.find((a) => a.type === "play" && setup.prefer.includes(handDefId(game, who, a.instanceId) ?? ""));
        const acts = legal.filter((a) => a.type !== "endTurn");
        const pool = acts.length > 0 && rand() < ACT_BIAS ? acts : legal;
        const body = wanted ?? pool[Math.floor(rand() * pool.length)];
        if (body === undefined) break;

        const before = { p1: game.view("p1"), p2: game.view("p2") };
        const events = game.act(who, body);
        for (const event of events) {
          if (OVERFLOWS.includes(event.type)) produced[event.type] = (produced[event.type] ?? 0) + 1;
        }
        for (const seat of ["p1", "p2"] as const) {
          const after = game.view(seat);
          const fresh = newEventsSince(before[seat].events, after.events);
          const expected = after.events.slice(after.events.length - events.length);
          if (fresh.length !== expected.length || fresh.some((event, i) => event !== expected[i])) {
            misses.push({ label: setup.label, game: setup.seed, action, seat, produced: events.length, handed: fresh.length });
          }
          for (const event of fresh) {
            if (!OVERFLOWS.includes(event.type)) continue;
            seen[seat].add(event.type);
            handed[`${seat}:${event.type}`] = (handed[`${seat}:${event.type}`] ?? 0) + 1;
          }
        }
      }
    }

    expect(misses.slice(0, 5), `${String(misses.length)} views handed the runner the wrong events`).toEqual([]);
    for (const seat of ["p1", "p2"] as const) {
      expect([...seen[seat]].sort(), `${seat}'s runner was handed each overflow`).toEqual([...OVERFLOWS].sort());
      // Once each: every overflow an action produced reached this seat's runner, and no more.
      for (const type of OVERFLOWS) expect(handed[`${seat}:${type}`], `${seat} ${type}`).toBe(produced[type]);
    }
  });
});
