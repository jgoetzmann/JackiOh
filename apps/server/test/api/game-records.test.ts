/**
 * SPEC §9.11, R376–R378: the live half of the card statistics. A finished match is filed once,
 * after its result, under its mode, the build's patch and two human pilots, and nothing about it
 * can cost the result. The scripted engine (`test/fakes/engine.ts`) plays the games, through the
 * real registry, actor and results writer; `engine.real.test.ts` runs the real engine's
 * `summarizeGame` through the port.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";
import type { ActionBody, PlayerId } from "@jackioh/shared";

import { loadCurrentPatch, patchesUrl } from "../../src/api/catalog";
import { loadEnv } from "../../src/env";
import { createRuntime } from "../../src/index";
import { setEnginePort } from "../../src/match/engine";
import { recordLiveGame } from "../../src/api/game-records";
import type { GameRecorder, QueueMode } from "../../src/api/ports";
import { createRecordResult } from "../../src/api/results";
import { createMatchClock } from "../../src/match/clock";
import { createMatchRegistry } from "../../src/match/registry";
import { createRecordingLogger, createTestDeps, TEST_CATALOG_VERSION, type TestDeps } from "../fakes/deps";
import { createFakeEngine, fakeDeck } from "../fakes/engine";

const MATCH_ID = "match-records";
const PATCH = "v9.9.9";
const P1_DECK = fakeDeck(["test-lethal"]);
const P2_DECK = fakeDeck(["test-prompt-self"]);

type Harness = { deps: TestDeps; submit: (player: PlayerId, nonce: string, body: ActionBody) => Promise<void> };

/** The two queue tickets a match in `mode` was paired from (§9.5): what tells the record its mode. */
function pairedTickets(deps: TestDeps, mode: QueueMode): void {
  for (const profileId of ["profile-1", "profile-2"]) {
    deps.store.tables.tickets.push({
      id: `ticket-${profileId}`,
      profileId,
      rating: 1000,
      mode,
      deck: [],
      trio: null,
      catalogVersion: TEST_CATALOG_VERSION,
      enqueuedAt: 0,
      status: "matched",
      matchId: MATCH_ID,
    });
  }
}

/**
 * A live match on the real registry, with the scripted engine and the real results writer, paired
 * from two `mode` tickets — or, with `mode: null`, from nothing a mode can be read off.
 */
async function liveMatch(mode: QueueMode | null, options: { recorder?: boolean } = {}): Promise<Harness> {
  const deps = createTestDeps();
  deps.store.seedProfile({ id: "profile-1", inMatchId: MATCH_ID });
  deps.store.seedProfile({ id: "profile-2", inMatchId: MATCH_ID });
  if (mode !== null) pairedTickets(deps, mode);
  const engine = createFakeEngine();
  if (options.recorder !== false) {
    const games: GameRecorder = { patch: PATCH, summarize: engine.summarizeGame };
    deps.games = games;
  }
  const registry = createMatchRegistry({
    store: deps.store,
    timers: deps.timers,
    config: deps.config,
    log: deps.log,
    engine,
    createClock: createMatchClock,
    recordResult: createRecordResult(deps),
  });
  await registry.start({
    matchId: MATCH_ID,
    seed: "seed-records",
    catalogVersion: TEST_CATALOG_VERSION,
    ranked: false,
    seats: [
      { profileId: "profile-1", player: "p1", deck: P1_DECK },
      { profileId: "profile-2", player: "p2", deck: P2_DECK },
    ],
  });
  const actor = await registry.actorFor(MATCH_ID);
  await actor.idle();
  return {
    deps,
    submit: async (player, nonce, body) => {
      await actor.submit(player, nonce, body);
      await actor.idle();
    },
  };
}

/** p1 ends turn 1, p2 ends turn 2, and p1 wins with `test-lethal` (hand slot 0) on turn 3. */
async function playToHeroDeath(h: Harness): Promise<void> {
  await h.submit("p1", "n1", { type: "endTurn" });
  await h.submit("p2", "n2", { type: "endTurn" });
  await h.submit("p1", "n3", { type: "play", instanceId: "p1-h0" });
}

function events(h: Harness, name: string): unknown[] {
  return h.deps.log.entries.filter((entry) => entry.event === name);
}

describe("live game records (§9.11)", () => {
  it("R376 files a finished match once its result is in: its mode, the patch, two human pilots and the game", async () => {
    const h = await liveMatch("random");
    await playToHeroDeath(h);

    expect(h.deps.store.tables.results).toHaveLength(1);
    expect(h.deps.store.tables.gameRecords).toEqual([
      {
        id: MATCH_ID,
        source: "live",
        mode: "random",
        patch: PATCH,
        pilots: { p1: "human", p2: "human" },
        game: {
          first: "p1",
          winner: "p1",
          reason: "hero-death",
          turns: 3,
          seats: {
            p1: { deck: P1_DECK, opening: P1_DECK.slice(0, 3), drawn: [], played: ["test-lethal"] },
            p2: { deck: P2_DECK, opening: P2_DECK.slice(0, 3), drawn: [], played: [] },
          },
        },
      },
    ]);
    expect(events(h, "game.recorded")).toHaveLength(1);
  });

  it("R376 files a game once, however many times its result is written", async () => {
    const h = await liveMatch("bo1");
    await playToHeroDeath(h);
    const again = createRecordResult(h.deps);
    const seats = [
      { profileId: "profile-1", player: "p1" as const, deck: P1_DECK },
      { profileId: "profile-2", player: "p2" as const, deck: P2_DECK },
    ] as const;
    await again({ matchId: MATCH_ID, seats, outcome: { winner: "p1", reason: "hero-death" }, turns: 3, at: 0 });

    expect(h.deps.store.tables.results).toHaveLength(1);
    expect(h.deps.store.tables.gameRecords).toHaveLength(1);
    expect(h.deps.store.tables.gameRecords[0]?.mode).toBe("bo1");
    expect(await recordLiveGame(h.deps, MATCH_ID)).toBeNull();
  });

  it("R376 never costs a result: a failed record is logged and the result stands", async () => {
    const h = await liveMatch("bo1");
    h.deps.store.onCall = (method) => {
      if (method === "gameRecords.insert") throw new Error("the records table is gone");
    };
    await playToHeroDeath(h);

    expect(h.deps.store.tables.results).toHaveLength(1);
    expect((await h.deps.store.matches.get(MATCH_ID))?.status).toBe("finished");
    expect(h.deps.store.tables.gameRecords).toEqual([]);
    expect(events(h, "game.record.failed")).toHaveLength(1);
  });

  it("R376 files nothing for a match no ticket, room or series made, nor without a recorder", async () => {
    const h = await liveMatch(null);
    await playToHeroDeath(h);

    expect(h.deps.store.tables.results).toHaveLength(1);
    expect(h.deps.store.tables.gameRecords).toEqual([]);
    expect(events(h, "game.record.skipped")).toHaveLength(1);
    expect(await recordLiveGame(h.deps, "no-such-match")).toBeNull();
    expect(events(h, "game.record.skipped")).toHaveLength(2);

    const bare = await liveMatch("bo1", { recorder: false });
    await playToHeroDeath(bare);
    expect(bare.deps.store.tables.results).toHaveLength(1);
    expect(bare.deps.store.tables.gameRecords).toEqual([]);
  });

  it("R376 alerts on a log that does not reach the result it ended with", async () => {
    const h = await liveMatch("bo1");
    await playToHeroDeath(h);
    h.deps.store.tables.gameRecords.length = 0;
    // The last action, the one that ended the game, goes missing from the log.
    h.deps.store.tables.matchActions.pop();

    expect(await recordLiveGame(h.deps, MATCH_ID)).toBeNull();
    expect(events(h, "game.record.unfinished")).toHaveLength(1);
  });

  it("R376 files a live game under the newest patch of R388's list", async () => {
    const list = JSON.parse(await readFile(new URL("patches.json", patchesUrl()), "utf8")) as { version: string }[];
    expect(await loadCurrentPatch()).toBe(list[list.length - 1]?.version);

    const dir = await mkdtemp(join(tmpdir(), "jackioh-patches-"));
    const at = (name: string): URL => pathToFileURL(join(dir, name));
    await writeFile(at("two.json"), JSON.stringify([{ version: "v1" }, { version: "v0.9" }]));
    // The list's order is the order of versions, never a comparison of the strings (R388).
    expect(await loadCurrentPatch(at("two.json"))).toBe("v0.9");
    await writeFile(at("empty.json"), "[]");
    await expect(loadCurrentPatch(at("empty.json"))).rejects.toThrow(/names no newest version/);
    await expect(loadCurrentPatch(at("missing.json"))).rejects.toThrow(/could not be read/);
  });

  it("R376 is bound at the composition root: the runtime files games under the newest patch, summarized by the engine port", async () => {
    const engine = createFakeEngine();
    setEnginePort(engine);
    try {
      // End-to-end mode, so the runtime needs no database and no auth provider.
      const env = loadEnv({
        SUPABASE_URL: "https://project.supabase.test",
        SUPABASE_SECRET_KEY: "sb_secret_0123456789abcdefghijklmnopqrstuv",
        DATABASE_URL: "postgres://postgres:postgres@localhost:5432/jackioh",
        CODE_PEPPER: "a-pepper-of-at-least-thirty-two-characters",
        CATALOG_VERSION: "core-1",
        PUBLIC_ORIGINS: "https://play.jackioh.test",
        NODE_ENV: "test",
        E2E: "1",
      });
      const { deps } = await createRuntime(env, { log: createRecordingLogger() });
      expect(deps.games?.patch).toBe(await loadCurrentPatch());
      expect(deps.games?.summarize).toBe(engine.summarizeGame);
    } finally {
      setEnginePort(null);
    }
  });
});
