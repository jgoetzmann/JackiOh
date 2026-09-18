/**
 * `src/match/engine.real.ts` — the real `EnginePort`, and until now the only file in `src/` with no
 * test at all.
 *
 * WHY IT NEEDS ONE. Every other test in this suite installs a scripted port through
 * `setEnginePort`, which is what lets the actor, the clock and the recovery tests run without the
 * engine in the process — and is exactly why nothing noticed when this file was missing its
 * `registerAll()` call. `createGame` looks its card definitions up in the engine's *registered*
 * catalog (`packages/engine/src/state.ts`: `validateDeck` throws `"core-001" is not in the catalog
 * (§9.4 L6)` when it is empty), so without that call every real match died on the first card of the
 * first deck while all 200-odd server tests stayed green. This file is the one that would have
 * caught it: it builds the port for real, with the real §8 catalog, and plays a card.
 *
 * It asks only what the adapter is responsible for — that the engine is reachable, registered and
 * driveable through the port's own surface. The rules those calls run are `packages/engine`'s and
 * `packages/cards`' business, and the fuzz suite plays 1,000 whole games of them (BUILD §4).
 */

import { describe, expect, it } from "vitest";

import type { Action, ActionBody, PlayerId } from "@jackioh/shared";

import { loadCatalog } from "../../src/api/catalog";
import { enginePort } from "../../src/match/engine.real.ts";
import type { EnginePort, EngineState } from "../../src/match/engine.ts";

/**
 * Actions that would end the game or that only the server may send (R79, R84). The walk below
 * avoids them for the same reason SPEC §10.7's policy does: it is looking for the first card play,
 * not for a way out of the match.
 */
const NEVER_CHOOSE = new Set<ActionBody["type"]>([
  "concede",
  "offerDraw",
  "answerDraw",
  "timeout",
  "disconnectExpired",
  "ceilingReached",
]);

/**
 * Two legal decks of real card ids.
 *
 * The deck size is not spelled here and is not imported either: BUILD §2 keeps `DECK_SIZE` in
 * `packages/engine/src/config.ts` and nothing restates it, and `engine.real.ts` is meant to be the
 * only file in `apps/server` that reaches `@jackioh/engine` — including from a test. So the size is
 * whatever the engine accepts: the slices grow until `createGame` stops objecting.
 *
 * That loop is also the assertion. With the catalog unregistered *every* size is refused, so the
 * failure this file exists for shows up here, as "the real engine refused every deck size", with
 * the engine's own sentence attached.
 */
function firstAcceptedDecks(
  port: EnginePort,
  pool: readonly string[],
  seed: string,
): { state: EngineState; decks: [string[], string[]] } {
  const refusals = new Set<string>();
  for (let size = 1; size * 2 <= pool.length; size += 1) {
    const decks: [string[], string[]] = [pool.slice(0, size), pool.slice(size, size * 2)];
    try {
      return { state: port.createGame({ seed, decks }), decks };
    } catch (error) {
      refusals.add(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(
    `the real engine refused every deck size built from the catalog:\n  ${[...refusals].join("\n  ")}`,
  );
}

describe("the real engine port (src/match/engine.real.ts)", () => {
  it("builds without the engine reporting a missing export", () => {
    // `enginePort()` throws `EngineUnavailableError` when `@jackioh/engine` is missing any of
    // `REQUIRED_ENGINE_EXPORTS`; getting a port back at all is that check passing.
    const port = enginePort();
    expect(typeof port.createGame).toBe("function");
    expect(typeof port.reduce).toBe("function");
    expect(typeof port.snapshot).toBe("function");
  });

  it("registers the card catalog, so createGame accepts a deck of real card ids", async () => {
    const catalog = await loadCatalog();
    const pool = catalog.cardIds.filter((cardId) => !catalog.isToken(cardId));
    const port = enginePort();

    const { state, decks } = firstAcceptedDecks(port, pool, "engine-real-createGame");

    // The decks really are §8 cards, so an empty registered catalog could not have produced this.
    expect(decks[0][0]).toBe(pool[0]);
    expect(port.snapshot(state).phase).toBe("setup");
    expect(port.snapshot(state).result).toBeNull();
  });

  it("reduces a first real card play without throwing", async () => {
    const catalog = await loadCatalog();
    const pool = catalog.cardIds.filter((cardId) => !catalog.isToken(cardId));
    const port = enginePort();

    const { state: created } = firstAcceptedDecks(port, pool, "engine-real-firstplay");
    let state = port.beginGame(created).state;

    // Walk the real game through the port's own surface — `snapshot` for whose turn it is,
    // `legalActions` for what may be done, `reduce` to do it — until a card is played.
    let played: ActionBody | null = null;
    let steps = 0;
    while (played === null && steps < 400 && port.snapshot(state).result === null) {
      const snapshot = port.snapshot(state);
      // With a prompt open only its holder may act (§9.3); otherwise it is the active player's.
      const player: PlayerId = snapshot.pendingFor ?? snapshot.active;
      const options = port.legalActions(state, player).filter((body) => !NEVER_CHOOSE.has(body.type));
      const choice =
        options.find((body) => body.type === "play") ??
        options.find((body) => body.type !== "endTurn") ??
        options[0];
      if (choice === undefined) break;

      const action = { ...choice, playerId: player, nonce: `step-${String(steps)}` } as Action;
      const result = port.reduce(state, action);

      // `legalActions` and `reduce` are the same engine: anything offered must be accepted.
      expect(result.error, `${action.type} was offered but refused`).toBeUndefined();
      state = result.state;
      if (choice.type === "play") played = choice;
      steps += 1;
    }

    expect(played, `no card was played in ${String(steps)} actions`).not.toBeNull();
    // A play of a card that came out of the deck, not an engine-invented instance.
    expect(port.snapshot(state).turn).toBeGreaterThan(0);
    // The port's other two projections work on a state a real card has passed through.
    expect(port.hashState(state).length).toBeGreaterThan(0);
    expect(port.viewFor(state, "p1")).not.toBeNull();
  });
});
