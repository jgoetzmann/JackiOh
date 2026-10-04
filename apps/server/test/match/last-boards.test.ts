/**
 * Last boards on the server (C+ #29 Portal to the Past, R417, R565; BUILD M9-T11: "a finished game
 * writes both seats' last boards, never the opponent's face-down cards").
 *
 * The first block is the real engine port under the real registry, actor and results writer, over
 * the in-memory store: a real game ends with a face-down card on the field, each seat's stored board
 * is exactly the field its own final view showed, and the next match between the same profiles
 * starts from those boards, frozen on its row, so a rebuilt actor folds the same game. The second
 * block is the wiring the real game cannot reach on demand, on the scripted engine.
 */

import { describe, expect, it } from "vitest";
import type { ActionBody, PlayerId, PlayerView } from "@jackioh/shared";
import { loadCatalog } from "../../src/api/catalog";
import type { LastBoardEntry } from "../../src/api/ports";
import { createRecordResult, reapStuckMatches } from "../../src/api/results";
import { createMatchClock } from "../../src/match/clock";
import type { ActorDeps } from "../../src/match/contracts";
import type { EnginePort } from "../../src/match/engine";
import { enginePort } from "../../src/match/engine.real.ts";
import { createMatchRegistry, type MatchRegistry } from "../../src/match/registry";
import { createTestDeps, TEST_CATALOG_VERSION } from "../fakes/deps";
import { createFakeEngine, fakeDeck } from "../fakes/engine";

const P1 = "profile-1";
const P2 = "profile-2";

/** A seat's own hand, as its view lists it. */
function handOf(view: PlayerView): { instanceId: string; defId: string }[] {
  const hand = view.you.hand;
  if (!Array.isArray(hand)) throw new Error("a seat's own hand is a list");
  return hand;
}

/** What a seat's own view shows of the field, p1's side then p2's, in board order (R417). */
function shownField(view: PlayerView): LastBoardEntry[] {
  const sides = [view.you, view.opponent].sort((a, b) => (a.player < b.player ? -1 : 1));
  return sides.flatMap((side) => [
    ...side.units.flatMap((unit) => (unit === null ? [] : [{ defId: unit.defId, radiant: unit.radiant }])),
    ...side.backrow.flatMap((card, lane) => {
      const carried = side.carried?.[lane] ?? null;
      return [
        ...(carried === null ? [] : [{ defId: carried.defId, radiant: carried.radiant }]),
        ...(card === null || card.faceDown ? [] : [{ defId: card.defId, radiant: card.radiant }]),
      ];
    }),
  ]);
}

function world(engine: EnginePort) {
  const deps = createTestDeps();
  deps.store.seedProfile({ id: P1, rating: 1000 });
  deps.store.seedProfile({ id: P2, rating: 1000 });
  const actorDeps: ActorDeps = {
    store: deps.store,
    timers: deps.timers,
    config: deps.config,
    log: deps.log,
    engine,
    createClock: createMatchClock,
    recordResult: createRecordResult(deps),
  };
  return { deps, registry: createMatchRegistry(actorDeps) };
}

async function start(registry: MatchRegistry, matchId: string, seed: string, decks: [string[], string[]]): Promise<void> {
  await registry.start({
    matchId,
    seed,
    catalogVersion: TEST_CATALOG_VERSION,
    ranked: false,
    seats: [
      { profileId: P1, player: "p1", deck: decks[0] },
      { profileId: P2, player: "p2", deck: decks[1] },
    ],
  });
}

/**
 * Cheap Traps that fire only on what the walk below never does — a lethal attack, a death of p1's
 * Unit, a hit to 0, a heal, a Spell — so the one p1 sets stays face-down to the end.
 */
const QUIET_TRAPS = ["core-096", "classic-014", "classic-052", "classicplus-022", "classic-017"];

describe("R417, R565 last boards through a real match", () => {
  it("R565 a finished game writes both seats' last boards, each the field its own view showed, never the opponent's face-down cards; the next match starts from them and a rebuild folds the same game", async () => {
    const catalog = await loadCatalog();
    const core = catalog.cardIds.filter((id) => !catalog.isToken(id) && catalog.defs[id]?.set === "Core");
    const decks: [string[], string[]] = [[...QUIET_TRAPS, ...core.slice(0, 15)], core.slice(15, 35)];
    const engine = enginePort();
    const { deps, registry } = world(engine);
    await start(registry, "m-last-1", "last-boards-real", decks);
    const actor = await registry.actorFor("m-last-1");

    let n = 0;
    const submit = async (player: PlayerId, body: ActionBody): Promise<void> => {
      n += 1;
      const reply = await actor.submit(player, `lb-${n}`, body);
      if (reply.type === "error") throw new Error(`${body.type} by ${player}: ${JSON.stringify(reply)}`);
    };
    const typeOf = (player: PlayerId, instanceId: string): string | undefined => {
      const card = handOf(actor.viewFor(player)).find((entry) => entry.instanceId === instanceId);
      return card === undefined ? undefined : catalog.defs[card.defId]?.type;
    };

    for (const player of ["p1", "p2"] as const) {
      await submit(player, { type: "mulligan", keep: handOf(actor.viewFor(player)).map((card) => card.instanceId) });
    }
    // p1 sets a quiet Trap, p2 plays a Unit; everything else ends the turn or answers the prompt.
    for (let step = 0; ; step += 1) {
      if (step > 80) throw new Error("the walk never put a face-down card and a Unit on the field");
      const seen = actor.viewFor("p2");
      const faceDown = seen.opponent.backrow.some((card) => card?.faceDown === true);
      const unit = seen.you.units.some((pile) => pile !== null);
      if (faceDown && unit) break;
      const snapshot = actor.snapshot();
      expect(snapshot.result).toBeNull();
      const who = snapshot.pendingFor ?? snapshot.active;
      const legal = engine.legalActions(actor.engineState(), who);
      const wanted = (want: string[]): ActionBody | undefined =>
        legal.find((action) => action.type === "play" && want.includes(typeOf(who, action.instanceId) ?? ""));
      const body =
        legal.find((action) => action.type === "answer") ??
        (who === "p1" && !faceDown ? wanted(["Trap", "Field Trap"]) : undefined) ??
        (who === "p2" && !unit ? wanted(["Unit"]) : undefined) ??
        legal.find((action) => action.type === "endTurn");
      if (body === undefined) throw new Error(`${who} has nothing to do`);
      await submit(who, body);
    }
    await submit("p2", { type: "concede" });
    await actor.idle();

    const own = must(await deps.store.lastBoards.get(P1, "server"));
    const theirs = must(await deps.store.lastBoards.get(P2, "server"));
    expect(own).toEqual(shownField(actor.viewFor("p1")));
    expect(theirs).toEqual(shownField(actor.viewFor("p2")));
    const trap = actor.viewFor("p1").you.backrow.find((card) => card !== null && card.faceDown === false && card.unrevealed === true);
    if (trap === undefined || trap === null || trap.faceDown) throw new Error("p1 holds no face-down card");
    expect(own.map((entry) => entry.defId)).toContain(trap.defId);
    expect(theirs.map((entry) => entry.defId)).not.toContain(trap.defId);
    expect(theirs.length).toBeLessThan(own.length);

    // The next match between them starts from those boards, frozen on its row (R417).
    await start(registry, "m-last-2", "last-boards-next", decks);
    expect((await deps.store.matches.get("m-last-2"))?.lastBoards).toEqual([own, theirs]);
    const next = await registry.actorFor("m-last-2");
    for (const player of ["p1", "p2"] as const) {
      n += 1;
      await next.submit(player, `lb-${n}`, { type: "mulligan", keep: handOf(next.viewFor(player)).map((card) => card.instanceId) });
    }
    const live = engine.hashState(next.engineState());
    // A newer board stored meanwhile changes nothing: a rebuilt actor folds the match's own inputs.
    await deps.store.lastBoards.put(P1, "server", [], deps.timers.now());
    await registry.stop("m-last-2");
    const rebuilt = await registry.actorFor("m-last-2");
    expect(engine.hashState(rebuilt.engineState())).toBe(live);
  });
});

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected a value");
  return value;
}

describe("R565 the results writer and the boards", () => {
  const BOARD_1: LastBoardEntry[] = [{ defId: "core-012", radiant: true }];
  const BOARD_2: LastBoardEntry[] = [{ defId: "core-025", radiant: false }];

  async function liveMatch(deps: ReturnType<typeof world>["deps"], id: string, ceilingAt: number): Promise<void> {
    await deps.store.matches.create({
      id,
      seed: "s",
      players: [P1, P2],
      decks: [fakeDeck(), fakeDeck()],
      catalogVersion: TEST_CATALOG_VERSION,
      status: "live",
      createdAt: deps.timers.now(),
      finishedAt: null,
      clocks: { turnDeadline: null, promptDeadline: null, graceDeadline: { p1: null, p2: null }, ceilingAt },
    });
  }

  const input = (matchId: string, at: number) => ({
    matchId,
    seats: [
      { profileId: P1, player: "p1" as const, deck: fakeDeck() },
      { profileId: P2, player: "p2" as const, deck: fakeDeck() },
    ] as const,
    outcome: { winner: "p1" as const, reason: "concede" as const },
    turns: 3,
    at,
    lastBoards: [BOARD_1, BOARD_2] as const,
  });

  it("R565 writes each seat's board once, in the result's transaction: a failed board write leaves no result", async () => {
    const { deps } = world(createFakeEngine());
    await liveMatch(deps, "m-tx", deps.timers.now() + 60_000);
    const record = createRecordResult(deps);
    deps.store.onCall = (method) => {
      if (method === "lastBoards.put") throw new Error("injected");
    };
    await expect(record(input("m-tx", deps.timers.now()))).rejects.toThrow("injected");
    expect(await deps.store.results.getByMatch("m-tx")).toBeNull();
    deps.store.onCall = null;

    await record(input("m-tx", deps.timers.now()));
    expect(await deps.store.lastBoards.get(P1, "server")).toEqual(BOARD_1);
    expect(await deps.store.lastBoards.get(P2, "server")).toEqual(BOARD_2);
    // A second write of the same ending is the first one's row and touches no board.
    await deps.store.lastBoards.put(P1, "server", [], deps.timers.now());
    await record(input("m-tx", deps.timers.now()));
    expect(await deps.store.lastBoards.get(P1, "server")).toEqual([]);
  });

  it("R565, R112 the reaper reads no state, so a reaped ceiling draw writes no board and the last one stays", async () => {
    const { deps } = world(createFakeEngine());
    await deps.store.lastBoards.put(P1, "server", BOARD_1, deps.timers.now());
    await liveMatch(deps, "m-reaped", deps.timers.now() - 1);
    expect(await reapStuckMatches(deps)).toEqual(["m-reaped"]);
    expect(await deps.store.results.getByMatch("m-reaped")).not.toBeNull();
    expect(await deps.store.lastBoards.get(P1, "server")).toEqual(BOARD_1);
    expect(await deps.store.lastBoards.get(P2, "server")).toBeNull();
  });
});
