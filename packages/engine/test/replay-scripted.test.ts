// Replay with scripted decks (SPEC §9.2, §9.3; REVIEW B1.2, B8). `replay.test.ts` folds 100 games
// to identical hashes, but its decks are script-less fixture units, so M3's new state queues are
// empty in every fold: the M3 review measured `echoQueue`, `triggerQueue`, `delayed` and the
// dispatch frontier as never reached across all 100 seeds. These decks are scripted — an
// end-of-turn trigger, a Death hook, two traps, a delayed effect, an Echo card and three cards
// that open prompts — so the folds exercise the queues, and the run asserts that they did.
//
// 30 seeds, not 100: a game on these decks runs ~85 actions rather than a vanilla game's handful
// (every prompt is an action of its own), and each seed is played once and then replayed twice —
// once through `fold` for the M1 gate's own check, once step by step to compare every state on the
// way. That is ~2,600 actions and three passes per seed, and it reaches every queue. The run is
// seeded end to end, so what it reaches is fixed rather than sampled: more seeds would add breadth,
// not confidence.

import type { Action, CardDef, GameEvent, PlayerId } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { DECK_SIZE } from "../src/config";
import { chooseMode, damage, draw } from "../src/effects";
import { scheduleDelayed } from "../src/modifiers";
import { beginGame, reduce, seatToAct } from "../src/reduce";
import { fold, hashState } from "../src/replay";
import { createRng } from "../src/rng";
import type { CardScripts, Script } from "../src/script";
import { registerScripts, registeredScripts } from "../src/scripts";
import { chooseAction } from "../src/subsystems/aiPolicy";
import { createGame, type GameState } from "../src/state";
import { setupCatalog } from "./fixtures/harness";

let nextIndex = 1400;
function def(name: string, type: CardDef["type"], extra: Partial<CardDef> = {}): CardDef {
  nextIndex += 1;
  return {
    id: `rs-${name}`,
    index: String(nextIndex),
    name: `${name} (replay)`,
    set: "Core",
    type,
    tags: [],
    rarity: "Common",
    token: false,
    cost: 1,
    base: { keywords: [], text: name },
    radiant: { keywords: [], text: name },
    ...extra,
  };
}

function unit(name: string, attack: number, health: number, extra: Partial<CardDef> = {}): CardDef {
  return def(name, "Unit", {
    base: { attack, health, keywords: extra.base?.keywords ?? [], text: name },
    radiant: { attack: attack * 2, health: health * 2, keywords: extra.base?.keywords ?? [], text: name },
    ...extra,
  });
}

/** #13's shape: at your end of turn it pings, so an end-of-turn trigger runs every turn. */
const closer = unit("closer", 1, 4);
/** A Death hook (§4.5 step 3), which needs the unit to die in combat first. */
const deathrattle = unit("deathrattle", 2, 1);
/** #50's shape: its Cry schedules an effect for your next start of turn (R76), so `delayed` fills. */
const delayer = unit("delayer", 2, 2);
/** A Cry that opens a prompt, so a play pauses mid-resolution (§10.6). */
const asker = unit("asker", 1, 1);
/**
 * Echo 2 on a Spell whose Cry prompts, so a repeat is left *waiting* in `echoQueue` while a prompt
 * is open. Echo 1 does not reach that state: `playSteps.takeEchoRepeat` drops the entry as it takes
 * the last repeat, so the one repeat is in flight (inside the owed play's own record) rather than
 * in the queue, and every state this run observes has `echoQueue` empty. With two, the first repeat
 * pauses on its fresh prompt while the second is still owed in the queue — which is what §10.5
 * step 6 has to survive a pause for, and what this run must pass through to prove the fold.
 */
const echoAsker = def("echo-asker", "Spell");
/** An ordinary queued trigger (R68). */
const watcher = def("watcher", "Field Spell");
/** A queued trigger that prompts, so the triggers behind it stay in `triggerQueue`. */
const askWatcher = def("ask-watcher", "Field Spell");
/** #41's shape: a Trap in the backrow that answers a summon and is consumed (§5.1, R17). */
const snapTrap = def("snap-trap", "Trap");
/** #18's shape: a Field Trap that answers the turn end and stays (R62's end-of-turn window). */
const endTrap = def("end-trap", "Field Trap");
/** #89's shape: a hand trigger, which answers from the hand rather than the field. */
const corpse = unit("corpse", 2, 2);

/** Bodies, so combat happens and units die: the cheapest way to reach the Death hooks. */
const rebornBody = unit("reborn-body", 2, 2, {
  base: { attack: 2, health: 2, keywords: [{ kind: "Reborn" }], text: "reborn" },
});
const taunter = unit("taunter", 2, 3, {
  base: { attack: 2, health: 3, keywords: [{ kind: "Taunt" }], text: "taunt" },
});
const shielded = unit("shielded", 2, 2, {
  base: { attack: 2, health: 2, keywords: [{ kind: "Divine Shield" }], text: "shield" },
});
const poisoner = unit("poisoner", 1, 3, {
  base: { attack: 1, health: 3, keywords: [{ kind: "Poisonous" }], text: "poison" },
});
const rusher = unit("rusher", 2, 2, {
  base: { attack: 2, health: 2, keywords: [{ kind: "Rush" }], text: "rush" },
});
const bodyA = unit("body-a", 3, 2, { cost: 2 });
const bodyB = unit("body-b", 2, 4, { cost: 2 });
const bodyC = unit("body-c", 4, 3, { cost: 3 });
/** A plain Spell and a Spell that draws, so the library and fatigue get used too. */
const bolt = def("bolt", "Spell");
const study = def("study", "Spell");

function both(script: Script): CardScripts {
  return { base: script, radiant: script };
}

const ping = (amount: number): Script => ({
  triggers: [{ id: "ping", on: ["cardPlayed"], run: () => [damage({ to: { of: "enemyHero" }, amount })] }],
});

const SCRIPTS: Record<string, CardScripts> = {
  [closer.id]: both({ endOfTurn: () => [damage({ to: { of: "enemyHero" }, amount: 1 })] }),
  [deathrattle.id]: both({ death: () => [damage({ to: { of: "enemyHero" }, amount: 2 })] }),
  [delayer.id]: both({
    cry: (ctx) => {
      if (ctx.self === null) return [];
      scheduleDelayed(ctx, ctx.controller, { phase: "start", player: ctx.controller }, {
        defId: delayer.id,
        hook: "delayed",
        step: "boom",
        radiant: ctx.radiant,
        instanceId: ctx.self.id,
        data: {},
      });
      return [];
    },
    delayed: () => [damage({ to: { of: "enemyHero" }, amount: 2 })],
  }),
  [asker.id]: both({
    cry: () => [chooseMode({ options: ["burn", "keep"], step: "answered" })],
    resume: {
      answered: (ctx) => {
        const pick = ctx.targets[0];
        return pick?.pick === "mode" && pick.option === "burn"
          ? [damage({ to: { of: "enemyHero" }, amount: 1 })]
          : [];
      },
    },
  }),
  [echoAsker.id]: both({
    staticFlags: { echo: 2 },
    cry: () => [chooseMode({ options: ["left", "right"], step: "answered" })],
    resume: { answered: () => [damage({ to: { of: "enemyHero" }, amount: 1 })] },
  }),
  [watcher.id]: both(ping(1)),
  [askWatcher.id]: both({
    triggers: [
      { id: "ask", on: ["cardPlayed"], run: () => [chooseMode({ options: ["yes", "no"], step: "answered" })] },
    ],
    resume: { answered: () => [] },
  }),
  [snapTrap.id]: both({
    triggers: [{ id: "snap", on: ["summoned"], run: () => [damage({ to: { of: "enemyHero" }, amount: 2 })] }],
  }),
  [endTrap.id]: both({
    triggers: [{ id: "toll", on: ["turnEnded"], run: () => [damage({ to: { of: "enemyHero" }, amount: 1 })] }],
  }),
  [corpse.id]: both({
    handTriggers: [
      { id: "eat", on: ["destroyed"], run: () => [damage({ to: { of: "enemyHero" }, amount: 1 })] },
    ],
  }),
  [bolt.id]: both({ cry: () => [damage({ to: { of: "enemyHero" }, amount: 2 })] }),
  [study.id]: both({ cry: () => [draw({ count: 1 })] }),
};

const DEFS: CardDef[] = [
  closer,
  deathrattle,
  delayer,
  asker,
  echoAsker,
  watcher,
  askWatcher,
  snapTrap,
  endTrap,
  corpse,
  rebornBody,
  taunter,
  shielded,
  poisoner,
  rusher,
  bodyA,
  bodyB,
  bodyC,
  bolt,
  study,
];

const DECK = DEFS.map((entry) => entry.id);
const DECKS: [string[], string[]] = [DECK, DECK];

/** The fixture catalog plus these cards; both the live game and the fold need them registered. */
function registerAll(): void {
  setupCatalog();
  registerCatalog({ ...registeredCatalog(), ...Object.fromEntries(DEFS.map((d) => [d.id, d])) });
  registerScripts({ ...registeredScripts(), ...SCRIPTS });
}

/** How full each state queue ever got, and how many traps fired, over a whole run. */
type Peaks = {
  triggerQueue: number;
  echoQueue: number;
  delayed: number;
  dispatch: number;
  work: number;
  /** States seen with a card's prompt open — the mulligan does not count (§10.6). */
  cardPrompts: number;
  trapsFired: number;
  actions: number;
};

function zeroPeaks(): Peaks {
  return {
    triggerQueue: 0,
    echoQueue: 0,
    delayed: 0,
    dispatch: 0,
    work: 0,
    cardPrompts: 0,
    trapsFired: 0,
    actions: 0,
  };
}

function observe(peaks: Peaks, state: GameState, events: readonly GameEvent[] = []): void {
  peaks.triggerQueue = Math.max(peaks.triggerQueue, state.triggerQueue.length);
  peaks.echoQueue = Math.max(peaks.echoQueue, state.echoQueue.length);
  peaks.delayed = Math.max(peaks.delayed, state.delayed.length);
  peaks.dispatch = Math.max(peaks.dispatch, state.dispatch.length);
  peaks.work = Math.max(peaks.work, state.work.length);
  if (state.pending !== null && state.pending.kind !== "mulligan") peaks.cardPrompts += 1;
  peaks.trapsFired += events.filter((event) => event.type === "trapFired").length;
}

function merge(into: Peaks, from: Peaks): void {
  into.triggerQueue = Math.max(into.triggerQueue, from.triggerQueue);
  into.echoQueue = Math.max(into.echoQueue, from.echoQueue);
  into.delayed = Math.max(into.delayed, from.delayed);
  into.dispatch = Math.max(into.dispatch, from.dispatch);
  into.work = Math.max(into.work, from.work);
  into.cardPrompts += from.cardPrompts;
  into.trapsFired += from.trapsFired;
  into.actions += from.actions;
}

const STEP_CAP = 4000;

/** Every state a game passed through, boiled down to what a divergence would show up in. */
type Walk = {
  state: GameState;
  /** The state hash after each action, so a divergence names the action it started at. */
  hashes: string[];
  peaks: Peaks;
};

/**
 * One game by the random policy of §10.7 (`chooseAction`, so the run draws from exactly the set
 * R84 names), walking every state it passes through on the way.
 */
function playScriptedGame(seed: string): Walk & { log: Action[] } {
  registerAll();
  let state = beginGame(createGame({ seed, decks: DECKS })).state;
  const policy = createRng(`policy-${seed}`);
  const log: Action[] = [];
  const peaks = zeroPeaks();
  const hashes = [hashState(state)];
  observe(peaks, state);

  for (let step = 0; state.result === null; step += 1) {
    if (step > STEP_CAP) throw new Error(`scripted game ${seed} did not finish`);
    const player: PlayerId = seatToAct(state);
    const chosen = chooseAction(state, player, policy);
    if (chosen === null) throw new Error(`no legal action for ${player} in game ${seed}`);

    const action = { ...chosen, playerId: player, nonce: `a${log.length}` } as Action;
    const result = reduce(state, action);
    if (result.error !== undefined) throw new Error(`${action.type} rejected in ${seed}: ${result.error}`);
    log.push(action);
    state = result.state;
    hashes.push(hashState(state));
    observe(peaks, state, result.events);
  }

  peaks.actions = log.length;
  return { state, log, hashes, peaks };
}

/**
 * The same log again from the seed, action by action, watching the same queues: `fold` returns only
 * the final state, and a queue that filled and emptied in between would leave no trace in it.
 */
function refoldWalking(seed: string, log: readonly Action[]): Walk {
  registerAll();
  let state = beginGame(createGame({ seed, decks: DECKS })).state;
  const peaks = zeroPeaks();
  const hashes = [hashState(state)];
  observe(peaks, state);

  for (const action of log) {
    const result = reduce(state, action);
    if (result.error !== undefined) throw new Error(`${action.type} rejected refolding ${seed}: ${result.error}`);
    state = result.state;
    hashes.push(hashState(state));
    observe(peaks, state, result.events);
  }

  peaks.actions = log.length;
  return { state, hashes, peaks };
}

type SeedRun = {
  seed: string;
  liveHash: string;
  replayHash: string;
  errors: { nonce: string; error: string }[];
  liveResult: GameState["result"];
  replayResult: GameState["result"];
  liveHashes: string[];
  replayHashes: string[];
  livePeaks: Peaks;
  /** What the replay passed through, which must be what the live game passed through. */
  replayPeaks: Peaks;
};

const SEEDS = Array.from({ length: 30 }, (_, i) => `scripted-${i + 1}`);

/** The whole run, computed once: the tests read it, in either order. */
let cached: { runs: SeedRun[]; live: Peaks; replayed: Peaks } | null = null;

function run(): NonNullable<typeof cached> {
  if (cached !== null) return cached;
  const runs: SeedRun[] = [];
  const live = zeroPeaks();
  const replayed = zeroPeaks();

  for (const seed of SEEDS) {
    const played = playScriptedGame(seed);
    merge(live, played.peaks);

    // Fold the recorded log from the seed in a fresh state (the M1 gate's own check), and then
    // walk the same log again to compare every state on the way, queues included.
    registerAll();
    const folded = fold({ seed, decks: DECKS, log: played.log });
    const walked = refoldWalking(seed, played.log);
    merge(replayed, walked.peaks);

    runs.push({
      seed,
      liveHash: hashState(played.state),
      replayHash: hashState(folded.state),
      errors: folded.errors,
      liveResult: played.state.result,
      replayResult: folded.state.result,
      liveHashes: played.hashes,
      replayHashes: walked.hashes,
      livePeaks: played.peaks,
      replayPeaks: walked.peaks,
    });
  }

  cached = { runs, live, replayed };
  return cached;
}

describe("replay with scripted decks (§9.2, §9.3)", () => {
  it("folds 30 scripted games to the same state hash", { timeout: 180_000 }, () => {
    const { runs } = run();
    expect(runs).toHaveLength(SEEDS.length);
    // §2.6: the scripted deck is a legal deck, which is why there are exactly this many cards.
    expect(DECK).toHaveLength(DECK_SIZE);

    for (const seed of runs) {
      expect(seed.errors, seed.seed).toEqual([]);
      expect(seed.replayHash, seed.seed).toBe(seed.liveHash);
      expect(seed.replayResult, seed.seed).toEqual(seed.liveResult);
      expect(seed.liveResult, seed.seed).not.toBeNull();
      // Not just the same ending: the same state after every single action, so a queue that
      // filled and emptied in between cannot have differed either.
      expect(seed.replayHashes, seed.seed).toEqual(seed.liveHashes);
    }
  });

  it("§10.1 exercises every state queue on the way, so the folds prove something", () => {
    const { live, replayed, runs } = run();

    // This is the gap B-9 recorded: a fold that never touches a queue proves nothing about it.
    expect(live.triggerQueue, "triggerQueue never held a trigger").toBeGreaterThan(0);
    expect(live.echoQueue, "echoQueue never held a repeat").toBeGreaterThan(0);
    expect(live.delayed, "delayed never held an effect").toBeGreaterThan(0);
    expect(live.dispatch, "the dispatch frontier was never owed an event").toBeGreaterThan(0);
    expect(live.work, "work never held an interrupted sequence").toBeGreaterThan(0);
    expect(live.cardPrompts, "no card ever opened a prompt").toBeGreaterThan(0);
    expect(live.trapsFired, "no trap ever fired").toBeGreaterThan(0);
    // And the games were real games, not two actions and a concede.
    expect(live.actions).toBeGreaterThan(SEEDS.length * 10);

    // The replay passed through the same depths, seed by seed: the queues are replayed, not
    // merely absent at both ends.
    expect(replayed).toEqual(live);
    for (const seed of runs) expect(seed.replayPeaks, seed.seed).toEqual(seed.livePeaks);
  });

  it("§9.3 a different seed gives a different hash, with the same scripted decks", () => {
    const a = playScriptedGame("scripted-hash-a");
    const b = playScriptedGame("scripted-hash-b");
    expect(hashState(a.state)).not.toBe(hashState(b.state));
  });
});
