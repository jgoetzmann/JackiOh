// docs/polish/1-animations.md, behaviours B1 to B5: the animation table's `fx` column, the runner's
// lifecycle signals, and the viewer's effects-speed and reduce settings (R201).
//
// `animations.test.ts` is B3's real proof: it must stay green without a single edit. This file adds
// what that one cannot see. Settings are injected through the queue's `settings` option, never by
// mutating the global store, and `fakeClock` is a local copy of `animations.test.ts`'s (not exported).

import { GAME_EVENT_TYPES, type GameEvent, type GameEventType } from "@jackioh/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ANIMATIONS,
  BURST_BUDGET_MS,
  MIN_ENTRY_MS,
  createAnimationQueue,
  planEntries,
  reducedMotionNow,
  scaleForSpeed,
  targetFor,
  type AnimationQueue,
  type RunnerSignal,
} from "./animations.ts";
import { testid } from "./contract.ts";
import { FX_SETTINGS_KEY, FX_SPEED_MAX, FX_SPEED_MIN } from "../fx/constants.ts";
import { DEFAULT_FX_SETTINGS, resetFxSettingsForTests, type FxSettings } from "../fx/settings.ts";
import { fullBoardView } from "../test/fixtures.ts";
import { setReducedMotion } from "../test/setup.ts";

function clearStorage(): void {
  try {
    window.localStorage.clear();
  } catch {
    // A test that broke storage restores it itself.
  }
}

beforeEach(() => {
  clearStorage();
  resetFxSettingsForTests();
});

afterEach(() => {
  setReducedMotion(false);
  clearStorage();
  resetFxSettingsForTests();
});

/* ------------------------------------------------------------------------------------------- *
 * Fixtures
 * ------------------------------------------------------------------------------------------- */

/** A `schedule` spy that records its calls and lets the test run the callbacks by hand. */
function fakeClock() {
  const calls: { ms: number; run: () => void }[] = [];
  const schedule = vi.fn((fn: () => void, ms: number) => {
    calls.push({ ms, run: fn });
  });
  return {
    schedule,
    calls,
    /** Fires the oldest pending callback. */
    tick(): void {
      const next = calls.shift();
      expect(next, "nothing scheduled").toBeDefined();
      next?.run();
    },
    /** Fires callbacks until none is left. */
    flush(): void {
      let guard = 0;
      while (calls.length > 0) {
        guard += 1;
        expect(guard, "schedule loop did not terminate").toBeLessThan(100_000);
        const next = calls.shift();
        next?.run();
      }
    },
    /** Every duration handed to `schedule`, in order. */
    scheduled(): number[] {
      return schedule.mock.calls.map((call) => Number(call[1]));
    },
  };
}

type Motion = Pick<FxSettings, "speed" | "motion">;

function at(speed: number, motion: FxSettings["motion"] = "system"): () => Motion {
  return () => ({ speed, motion });
}

const MANA: GameEvent = { type: "manaChanged", player: "p1", current: 1, max: 4 };
const DAMAGE: GameEvent = { type: "damage", sourceId: "u1", targetId: "u6", amount: 2, combat: true };
const TRAP: GameEvent = { type: "trapFired", instanceId: "hidden", defId: "hidden", controller: "p2", row: "backrow", lane: 2 };
const TURN_STARTED: GameEvent = { type: "turnStarted", player: "p1", turn: 4 };
const TURN_AUTO_ENDED: GameEvent = { type: "turnAutoEnded", player: "p1", turn: 4 };
const TURN_ENDED: GameEvent = { type: "turnEnded", player: "p1", turn: 4, unspentMana: 0 };
const GAME_OVER: GameEvent = { type: "gameOver", winner: "p1", reason: "hero-death" };

/** One event of every type, copied in spirit from `animations.test.ts` (inline, per the brief). */
const SAMPLES: { [K in GameEventType]: Extract<GameEvent, { type: K }> } = {
  cardPlayed: { type: "cardPlayed", player: "p1", instanceId: "c1", defId: "core-002", costPaid: 1 },
  cardResolved: { type: "cardResolved", player: "p1", instanceId: "c1", defId: "core-002", permanent: true, costPaid: 1 },
  summoned: { type: "summoned", player: "p1", instanceId: "c1", defId: "core-002", row: "units", lane: 2 },
  damage: { type: "damage", sourceId: "u1", targetId: "hero-p2", amount: 4, combat: true },
  healthLost: { type: "healthLost", player: "p1", amount: 3 },
  healed: { type: "healed", targetId: "hero-p1", amount: 2 },
  divineShieldLost: { type: "divineShieldLost", instanceId: "u6" },
  destroyed: { type: "destroyed", instanceId: "u1", defId: "core-004", owner: "p1", attack: 2, maxHealth: 3, killerId: "u6" },
  enteredGraveyard: { type: "enteredGraveyard", instanceId: "u1", defId: "core-004", owner: "p1" },
  exiled: { type: "exiled", instanceId: "u2", defId: "core-011", owner: "p1" },
  bounced: { type: "bounced", instanceId: "u3", defId: "core-017", owner: "p1" },
  burned: { type: "burned", instanceId: "cX", defId: "core-041", owner: "p2" },
  discarded: { type: "discarded", instanceId: "c11", defId: "core-002", owner: "p1" },
  drawn: { type: "drawn", player: "p1", instanceId: "cY", defId: "core-055" },
  addedToHand: { type: "addedToHand", player: "p2", instanceId: "cZ", defId: "core-060" },
  shuffledIn: { type: "shuffledIn", player: "p1", instanceId: "cW", defId: "core-070", position: 3 },
  buffed: { type: "buffed", instanceId: "u2", attack: 1, health: 1 },
  keywordGranted: { type: "keywordGranted", instanceId: "u2", keyword: { kind: "Taunt" } },
  counterChanged: { type: "counterChanged", instanceId: "u2", counter: "plague", value: 3 },
  costChanged: { type: "costChanged", instanceId: "c11", cost: 0 },
  modifierChanged: { type: "modifierChanged", player: "p2", modifierId: "m4", added: true },
  radiantSet: { type: "radiantSet", instanceId: "u3", defId: "core-017", zone: { z: "field", player: "p1", row: "units", lane: 2 } },
  transformed: { type: "transformed", instanceId: "u3", fromDefId: "core-017", toDefId: "token-sheep", newInstanceId: "c90" },
  fused: { type: "fused", instanceIds: ["u1", "u2"], resultInstanceId: "c91", defId: "core-088" },
  positionSwitched: { type: "positionSwitched", instanceId: "u3", position: "DEF" },
  controlChanged: { type: "controlChanged", instanceId: "u6", controller: "p1", row: "units", lane: 4 },
  rotated: { type: "rotated", direction: "left" },
  swapped: { type: "swapped", what: "health" },
  locked: { type: "locked", player: "p2", row: "backrow", lane: 1 },
  trapFired: { type: "trapFired", instanceId: "b5", defId: "core-084", controller: "p1", row: "backrow", lane: 3 },
  attackDeclared: { type: "attackDeclared", attackerId: "u1", targetId: "u6", forced: false },
  attackCancelled: { type: "attackCancelled", attackerId: "u1", targetId: "u6", byInstanceId: "b5" },
  manaChanged: { type: "manaChanged", player: "p1", current: 2, max: 4 },
  turnStarted: { type: "turnStarted", player: "p1", turn: 3 },
  turnEnded: { type: "turnEnded", player: "p1", turn: 3, unspentMana: 2 },
  turnAutoEnded: { type: "turnAutoEnded", player: "p1", turn: 3 },
  promptOpened: { type: "promptOpened", player: "p1", choiceId: "ch1", kind: "discover" },
  promptAnswered: { type: "promptAnswered", player: "p1", choiceId: "ch1" },
  drawOffered: { type: "drawOffered", player: "p2" },
  drawAnswered: { type: "drawAnswered", player: "p1", accept: false },
  gameOver: { type: "gameOver", winner: "p1", reason: "hero-death" },
};

function longStream(rounds: number): GameEvent[] {
  const out: GameEvent[] = [];
  for (let i = 0; i < rounds; i += 1) out.push(...GAME_EVENT_TYPES.map((t) => SAMPLES[t]));
  return out;
}

/** Runs `events` through a fresh queue at `speed` and returns every duration it scheduled. */
function scheduledAt(speed: number, events: readonly GameEvent[]): number[] {
  const clock = fakeClock();
  const queue = createAnimationQueue({ schedule: clock.schedule, reducedMotion: false, settings: at(speed) });
  queue.enqueue(events, fullBoardView());
  clock.flush();
  expect(queue.idle()).toBe(true);
  return clock.scheduled();
}

function listen(queue: AnimationQueue): RunnerSignal[] {
  const seen: RunnerSignal[] = [];
  queue.subscribeSignals((signal) => {
    seen.push(signal);
  });
  return seen;
}

function kinds(signals: readonly RunnerSignal[]): string[] {
  return signals.map((s) => s.kind);
}

function startOf(signal: RunnerSignal | undefined) {
  if (signal === undefined || signal.kind !== "start") throw new Error(`expected a start signal, got ${signal?.kind}`);
  return signal.entry;
}

/* ------------------------------------------------------------------------------------------- *
 * B1: the fx column
 * ------------------------------------------------------------------------------------------- */

/** S4's table, literally: `type → recipe`, `null` for the 11 rows that carry no effect. */
const S4_RECIPES: Record<GameEventType, string | null> = {
  cardPlayed: "cast",
  summoned: "summon",
  damage: "impact",
  healthLost: "drain",
  healed: "heal",
  divineShieldLost: "shieldBreak",
  destroyed: "death",
  exiled: "void",
  bounced: "bounce",
  burned: "burn",
  discarded: "discard",
  drawn: "draw",
  addedToHand: "handGlint",
  shuffledIn: "shuffle",
  buffed: "buff",
  keywordGranted: "keyword",
  counterChanged: "counter",
  costChanged: "glint",
  modifierChanged: "glint",
  radiantSet: "radiant",
  transformed: "smoke",
  fused: "fuse",
  controlChanged: "mindControl",
  locked: "lock",
  trapFired: "trap",
  attackDeclared: "lunge",
  attackCancelled: "fizzle",
  manaChanged: "mana",
  turnStarted: "banner",
  turnAutoEnded: "banner",
  cardResolved: null,
  enteredGraveyard: null,
  positionSwitched: null,
  rotated: null,
  swapped: null,
  turnEnded: null,
  promptOpened: null,
  promptAnswered: null,
  drawOffered: null,
  drawAnswered: null,
  gameOver: null,
};

/** Every member of S1's `FxRecipe`. */
const FX_RECIPES = [
  "cast",
  "summon",
  "impact",
  "drain",
  "heal",
  "shieldBreak",
  "death",
  "void",
  "bounce",
  "burn",
  "discard",
  "draw",
  "handGlint",
  "shuffle",
  "buff",
  "keyword",
  "counter",
  "glint",
  "radiant",
  "smoke",
  "fuse",
  "mindControl",
  "lock",
  "trap",
  "lunge",
  "fizzle",
  "mana",
  "banner",
];

/** The pre-task table's `animation`, `durationMs` and `testid` per row, which S4 keeps byte for byte. */
const KEPT: Record<GameEventType, readonly [string, number, string]> = {
  cardPlayed: ["jk-card-played", 400, "hand-card-<instanceId>"],
  cardResolved: ["jk-card-resolved", 150, "resolved-<instanceId>"],
  summoned: ["jk-summon-scale", 250, "zone-<side>-<row>-<lane>"],
  damage: ["jk-damage-shake", 300, "card-<targetId> | hero-<side>"],
  healthLost: ["jk-loss-pop", 300, "hero-<side>"],
  healed: ["jk-heal-pop", 300, "card-<targetId> | hero-<side>"],
  divineShieldLost: ["jk-shield-shatter", 250, "card-<instanceId>"],
  destroyed: ["jk-dissolve", 350, "card-<instanceId>"],
  enteredGraveyard: ["jk-pile-pulse", 150, "graveyard-<side>"],
  exiled: ["jk-exile-fade", 350, "card-<instanceId>"],
  bounced: ["jk-bounce-to-hand", 350, "card-<instanceId>"],
  burned: ["jk-burn-away", 400, "hand-<side>"],
  discarded: ["jk-discard-drop", 300, "hand-card-<instanceId>"],
  drawn: ["jk-draw-slide", 250, "library-<side>"],
  addedToHand: ["jk-hand-edge", 250, "hand-<side>"],
  shuffledIn: ["jk-shuffle-in", 300, "library-<side>"],
  buffed: ["jk-stat-tick", 250, "card-<instanceId>"],
  keywordGranted: ["jk-icon-pop", 200, "card-<instanceId>"],
  counterChanged: ["jk-badge-tick", 200, "card-<instanceId>"],
  costChanged: ["jk-gem-tick", 200, "card-<instanceId> | hand-card-<instanceId>"],
  modifierChanged: ["jk-badge-fade", 200, "modifiers-<side>"],
  radiantSet: ["jk-radiant-pulse", 400, "card-<instanceId>"],
  transformed: ["jk-spin-face", 400, "card-<instanceId>"],
  fused: ["jk-fuse-merge", 500, "card-<instanceIds[0]>"],
  positionSwitched: ["jk-rotate-def", 250, "card-<instanceId>"],
  controlChanged: ["jk-cross-centre", 450, "zone-<side>-<row>-<lane>"],
  rotated: ["jk-lane-slide", 500, "board"],
  swapped: ["jk-swap-cross", 500, "board"],
  locked: ["jk-chain-close", 250, "zone-<side>-<row>-<lane>"],
  trapFired: ["jk-trap-flip", 700, "card-<instanceId>"],
  attackDeclared: ["jk-lunge", 350, "card-<attackerId>"],
  attackCancelled: ["jk-snap-back", 350, "card-<attackerId>"],
  manaChanged: ["jk-crystal-fill", 150, "mana-<side>"],
  turnStarted: ["jk-banner", 600, "turn-banner"],
  turnEnded: ["jk-grey-out", 150, "end-turn"],
  turnAutoEnded: ["jk-banner", 600, "turn-banner"],
  promptOpened: ["jk-fade-in", 150, "prompt-modal"],
  promptAnswered: ["jk-fade-out", 150, "prompt-modal"],
  drawOffered: ["jk-toast-in", 150, "draw-toast"],
  drawAnswered: ["jk-toast-resolve", 300, "draw-toast"],
  gameOver: ["jk-result-overlay", 0, "result-overlay"],
};

describe("B1 the fx column of ANIMATIONS", () => {
  it("B1 exactly the 30 rows of S4 carry fx with the listed recipe and the other 11 carry none", () => {
    const actual = Object.fromEntries(GAME_EVENT_TYPES.map((t) => [t, ANIMATIONS[t].fx?.recipe ?? null]));
    expect(actual).toEqual(S4_RECIPES);
    expect(GAME_EVENT_TYPES.filter((t) => ANIMATIONS[t].fx !== undefined)).toHaveLength(30);
  });

  it("B1 an fx descriptor is data only: one recipe field and nothing else", () => {
    for (const type of GAME_EVENT_TYPES) {
      const recipe = S4_RECIPES[type];
      if (recipe === null) continue;
      expect(ANIMATIONS[type].fx, type).toEqual({ recipe });
      expect(Object.keys(ANIMATIONS[type].fx ?? {}), type).toEqual(["recipe"]);
    }
  });

  it("B1 the 11 rows without an effect have no fx value at all", () => {
    const bare = GAME_EVENT_TYPES.filter((t) => S4_RECIPES[t] === null);
    expect(bare).toHaveLength(11);
    for (const type of bare) expect(ANIMATIONS[type].fx, type).toBeUndefined();
  });

  it("B1 every FxRecipe decorates at least one row and no row names another recipe", () => {
    const used = new Set(
      GAME_EVENT_TYPES.flatMap((t) => {
        const fx = ANIMATIONS[t].fx;
        return fx === undefined ? [] : [fx.recipe];
      }),
    );
    expect([...used].sort()).toEqual([...FX_RECIPES].sort());
  });

  it("B1 every row keeps its animation, duration and testid template", () => {
    const actual = Object.fromEntries(
      GAME_EVENT_TYPES.map((t) => [t, [ANIMATIONS[t].animation, ANIMATIONS[t].durationMs, ANIMATIONS[t].testid]]),
    );
    expect(actual).toEqual(KEPT);
  });

  it("B1 gameOver still lasts 0 ms, so the runner never plays it", () => {
    expect(ANIMATIONS.gameOver.durationMs).toBe(0);
    expect(ANIMATIONS.gameOver.fx).toBeUndefined();
    const clock = fakeClock();
    const queue = createAnimationQueue({ schedule: clock.schedule, reducedMotion: false, settings: at(0.5) });
    queue.enqueue([GAME_OVER], fullBoardView());
    expect(clock.schedule).not.toHaveBeenCalled();
  });

  it("B1 row targets still resolve exactly as before", () => {
    const view = fullBoardView();
    expect(targetFor({ type: "damage", sourceId: "u1", targetId: "hero-p2", amount: 3, combat: true }, view)).toBe(
      testid.hero("opponent"),
    );
    expect(
      targetFor({ type: "summoned", player: "p1", instanceId: "c1", defId: "core-002", row: "units", lane: 3 }, view),
    ).toBe(testid.zone("you", "units", 3));
    expect(targetFor({ type: "controlChanged", instanceId: "u6", controller: "p1", row: "units", lane: 4 }, view)).toBe(
      testid.zone("you", "units", 4),
    );
    expect(targetFor(TRAP, view)).toBe(testid.zone("opponent", "backrow", 2));
    expect(targetFor({ type: "damage", sourceId: null, targetId: "nope", amount: 1, combat: false }, view)).toBeNull();
    expect(targetFor(TURN_STARTED, view)).toBe(testid.banner);
  });
});

/* ------------------------------------------------------------------------------------------- *
 * B2: runner signals
 * ------------------------------------------------------------------------------------------- */

describe("B2 subscribeSignals", () => {
  it("B2 planEntries sets entry.view to the view it planned against", () => {
    const view = fullBoardView();
    const entries = planEntries([MANA, DAMAGE], view, false);
    expect(entries).toHaveLength(2);
    for (const entry of entries) expect(entry.view).toBe(view);
  });

  it("B2 start is emitted synchronously as the head entry goes in flight, right after the board is notified", () => {
    const clock = fakeClock();
    const queue = createAnimationQueue({ schedule: clock.schedule, reducedMotion: false, settings: at(1) });
    const log: string[] = [];
    let inFlightAtStart: unknown = "unset";
    queue.subscribe(() => log.push("notify"));
    const seen: RunnerSignal[] = [];
    queue.subscribeSignals((signal) => {
      log.push(signal.kind);
      seen.push(signal);
      if (signal.kind === "start") inFlightAtStart = queue.inFlight();
    });

    queue.enqueue([MANA, DAMAGE], fullBoardView());

    expect(log).toEqual(["notify", "start"]);
    const entry = startOf(seen[0]);
    expect(entry.type).toBe("manaChanged");
    expect(entry.durationMs).toBe(150);
    expect(inFlightAtStart).toEqual(entry);
  });

  it("B2 a queued entry emits start when it goes in flight, not when it is queued", () => {
    const clock = fakeClock();
    const queue = createAnimationQueue({ schedule: clock.schedule, reducedMotion: false, settings: at(1) });
    const seen = listen(queue);

    queue.enqueue([MANA], fullBoardView());
    queue.enqueue([DAMAGE, TURN_STARTED], fullBoardView());
    expect(kinds(seen)).toEqual(["start"]);

    clock.tick();
    expect(kinds(seen)).toEqual(["start", "start"]);
    expect(startOf(seen[1]).type).toBe("damage");

    clock.tick();
    expect(startOf(seen[2]).type).toBe("turnStarted");
    expect(startOf(seen[2]).durationMs).toBe(600);
  });

  it("B2 start carries the planning view and the duration the runner actually gave the entry", () => {
    const clock = fakeClock();
    const view = fullBoardView();
    const queue = createAnimationQueue({ schedule: clock.schedule, reducedMotion: false, settings: at(2) });
    const seen = listen(queue);

    queue.enqueue([TRAP], view);

    const entry = startOf(seen[0]);
    expect(entry.durationMs).toBe(350);
    expect(entry.view).toBe(view);
    expect(clock.scheduled()).toEqual([350]);
  });

  it("B2 idle is emitted once each time the queue settles, right after onSettled", () => {
    const clock = fakeClock();
    const log: string[] = [];
    const onSettled = vi.fn(() => {
      log.push("settled");
    });
    const queue = createAnimationQueue({ schedule: clock.schedule, reducedMotion: false, onSettled, settings: at(1) });
    queue.subscribeSignals((signal) => log.push(signal.kind));

    queue.enqueue([MANA, DAMAGE], fullBoardView());
    clock.flush();
    expect(log).toEqual(["start", "start", "settled", "idle"]);

    queue.enqueue([TURN_ENDED], fullBoardView());
    clock.flush();
    expect(log).toEqual(["start", "start", "settled", "idle", "start", "settled", "idle"]);
    expect(onSettled).toHaveBeenCalledTimes(2);
  });

  it("B2 a zero-duration entry emits no start", () => {
    const clock = fakeClock();
    const queue = createAnimationQueue({ schedule: clock.schedule, reducedMotion: false, settings: at(1) });
    const seen = listen(queue);

    queue.enqueue([GAME_OVER], fullBoardView());
    expect(kinds(seen)).toEqual(["idle"]);

    queue.enqueue([MANA, GAME_OVER, TURN_ENDED], fullBoardView());
    clock.flush();
    const started = seen.filter((s) => s.kind === "start").map((s) => startOf(s).type);
    expect(started).toEqual(["manaChanged", "turnEnded"]);
  });

  it("B2 under reduced motion nothing starts and the queue emits a single idle", () => {
    const clock = fakeClock();
    const queue = createAnimationQueue({ schedule: clock.schedule, reducedMotion: true, settings: at(1) });
    const seen = listen(queue);

    queue.enqueue(longStream(2), fullBoardView());

    expect(kinds(seen)).toEqual(["idle"]);
  });

  it("B2 an empty enqueue emits idle and no start", () => {
    const clock = fakeClock();
    const queue = createAnimationQueue({ schedule: clock.schedule, reducedMotion: false, settings: at(1) });
    const seen = listen(queue);

    queue.enqueue([], fullBoardView());

    expect(kinds(seen)).toEqual(["idle"]);
    expect(clock.schedule).not.toHaveBeenCalled();
  });

  it("B2 drain emits drain, and reset emits reset", () => {
    const clock = fakeClock();
    const queue = createAnimationQueue({ schedule: clock.schedule, reducedMotion: false, settings: at(1) });
    const seen = listen(queue);

    queue.enqueue(longStream(1), fullBoardView());
    const before = seen.length;
    const cut = [queue.inFlight(), ...Array.from({ length: queue.pending() })];
    queue.drain();
    const drained = seen.slice(before);
    expect(drained.map((signal) => signal.kind)).toEqual(["drain"]);
    // The drain names the entries it cut short: the one in flight first, then every one waiting.
    const entries = drained[0]?.kind === "drain" ? drained[0].entries : [];
    expect(entries).toHaveLength(cut.length);
    expect(entries[0]).toBe(cut[0]);

    queue.enqueue(longStream(1), fullBoardView());
    const again = seen.length;
    queue.reset();
    expect(seen.slice(again)).toEqual([{ kind: "reset" }]);
  });

  it("B2 drain and reset on an idle queue still emit their signal", () => {
    const clock = fakeClock();
    const queue = createAnimationQueue({ schedule: clock.schedule, reducedMotion: false, settings: at(1) });
    const seen = listen(queue);

    queue.drain();
    queue.reset();

    expect(seen).toEqual([{ kind: "drain", entries: [] }, { kind: "reset" }]);
  });

  it("B2 a timer left over from before a drain emits nothing", () => {
    const clock = fakeClock();
    const queue = createAnimationQueue({ schedule: clock.schedule, reducedMotion: false, settings: at(1) });
    const seen = listen(queue);

    queue.enqueue([MANA, DAMAGE, TURN_STARTED], fullBoardView());
    queue.drain();
    const after = seen.length;
    clock.flush();

    expect(seen.length).toBe(after);
  });

  it("B2 an unsubscribed listener hears nothing more", () => {
    const clock = fakeClock();
    const queue = createAnimationQueue({ schedule: clock.schedule, reducedMotion: false, settings: at(1) });
    const listener = vi.fn();
    const off = queue.subscribeSignals(listener);

    off();
    queue.enqueue([MANA], fullBoardView());
    clock.flush();
    queue.drain();
    queue.reset();

    expect(listener).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------------------------------- *
 * B3: default settings change nothing
 * ------------------------------------------------------------------------------------------- */

describe("B3 default settings", () => {
  it("B3 the default settings schedule exactly what a queue with no settings option schedules", () => {
    expect(DEFAULT_FX_SETTINGS).toEqual({ speed: 1, intensity: "normal", motion: "system" });

    const injected = fakeClock();
    const plain = fakeClock();
    const withSettings = createAnimationQueue({
      schedule: injected.schedule,
      reducedMotion: false,
      settings: () => ({ ...DEFAULT_FX_SETTINGS }),
    });
    const without = createAnimationQueue({ schedule: plain.schedule, reducedMotion: false });

    for (const events of [[MANA, DAMAGE, TURN_STARTED], longStream(3)]) {
      withSettings.enqueue(events, fullBoardView());
      without.enqueue(events, fullBoardView());
      injected.flush();
      plain.flush();
    }

    expect(injected.scheduled()).toEqual(plain.scheduled());
    expect(injected.scheduled().slice(0, 3)).toEqual([150, 300, 600]);
  });

  it("B3 at speed 1 an over-budget burst is squeezed exactly as before", () => {
    // Four 700 ms trap flips are 2,800 ms against a 2,400 ms budget.
    expect(4 * ANIMATIONS.trapFired.durationMs).toBeGreaterThan(BURST_BUDGET_MS);
    expect(scheduledAt(1, [TRAP, TRAP, TRAP, TRAP])).toEqual([600, 600, 600, 600]);
  });
});

/* ------------------------------------------------------------------------------------------- *
 * B4: R201, the speed setting
 * ------------------------------------------------------------------------------------------- */

describe("B4 the effects speed scales the table", () => {
  it("R201 the effects speed divides every non-zero duration and the burst budget, clamped to [0.5, 2]", () => {
    // 700 + 600 + 600 = 1,900 ms: inside the budget at every speed once the budget is divided too.
    const burst = [TRAP, TURN_STARTED, TURN_AUTO_ENDED];
    expect(scheduledAt(1, burst)).toEqual([700, 600, 600]);
    expect(scheduledAt(2, burst)).toEqual([350, 300, 300]);
    expect(scheduledAt(0.5, burst)).toEqual([1400, 1200, 1200]);
    // 5 is clamped to FX_SPEED_MAX.
    expect(scheduledAt(5, burst)).toEqual([350, 300, 300]);

    // Over budget at speed 1, so over budget at every speed, and squeezed by the same factor.
    const over = [TRAP, TRAP, TRAP, TRAP];
    expect(scheduledAt(2, over)).toEqual([300, 300, 300, 300]);
    expect(scheduledAt(0.5, over)).toEqual([1200, 1200, 1200, 1200]);
    expect(scheduledAt(5, over)).toEqual([300, 300, 300, 300]);
  });

  it("B4 scaleForSpeed: 0 stays 0, speed 1 is the identity, other speeds divide and round", () => {
    expect(scaleForSpeed(0, 2)).toBe(0);
    expect(scaleForSpeed(0, 0.5)).toBe(0);
    expect(scaleForSpeed(300, 1)).toBe(300);
    expect(scaleForSpeed(700, 1)).toBe(700);
    // Speed 1 returns d unchanged even below the floor.
    expect(scaleForSpeed(100, 1)).toBe(100);
    expect(scaleForSpeed(300, 2)).toBe(150);
    expect(scaleForSpeed(300, 0.5)).toBe(600);
    expect(scaleForSpeed(350, 2)).toBe(175);
    expect(scaleForSpeed(250, 1.5)).toBe(167);
    expect(scaleForSpeed(600, 0.75)).toBe(800);
  });

  it("B4 scaleForSpeed never goes below MIN_ENTRY_MS", () => {
    expect(scaleForSpeed(150, 2)).toBe(MIN_ENTRY_MS);
    expect(scaleForSpeed(200, 2)).toBe(MIN_ENTRY_MS);
    expect(scaleForSpeed(240, 2)).toBe(MIN_ENTRY_MS);
    expect(scaleForSpeed(250, 2)).toBe(125);
    expect(scheduledAt(2, [MANA])).toEqual([MIN_ENTRY_MS]);
  });

  it("B4 scaleForSpeed clamps speeds above FX_SPEED_MAX and below FX_SPEED_MIN", () => {
    expect(FX_SPEED_MIN).toBe(0.5);
    expect(FX_SPEED_MAX).toBe(2);
    expect(scaleForSpeed(300, 5)).toBe(150);
    expect(scaleForSpeed(300, 100)).toBe(150);
    expect(scaleForSpeed(300, 0.1)).toBe(600);
    expect(scaleForSpeed(300, 0.25)).toBe(600);
  });

  it("B4 a zero or negative speed is clamped to FX_SPEED_MIN rather than dividing by it", () => {
    expect(scaleForSpeed(300, 0)).toBe(600);
    expect(scaleForSpeed(300, -2)).toBe(600);
    expect(scheduledAt(0, [TRAP])).toEqual([1400]);
    expect(scheduledAt(-1, [TRAP])).toEqual([1400]);
  });

  it("B4 a zero duration stays zero whatever the speed, valid or not", () => {
    for (const speed of [0.5, 2, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(scaleForSpeed(0, speed), String(speed)).toBe(0);
    }
  });

  it("B4 a non-finite speed plays at speed 1", () => {
    expect(scaleForSpeed(300, Number.NaN)).toBe(300);
    expect(scaleForSpeed(300, Number.POSITIVE_INFINITY)).toBe(300);
    expect(scaleForSpeed(300, Number.NEGATIVE_INFINITY)).toBe(300);
    expect(scheduledAt(Number.NaN, [TRAP, TURN_STARTED])).toEqual([700, 600]);
  });

  it("B4 a burst inside the budget at speed 1 is not squeezed at speed 0.5, because the budget is divided too", () => {
    // 3,800 ms of slowed motion would blow an undivided 2,400 ms budget.
    const slowed = [TRAP, TURN_STARTED, TURN_AUTO_ENDED].map((e) => scaleForSpeed(ANIMATIONS[e.type].durationMs, 0.5));
    expect(slowed.reduce((a, b) => a + b, 0)).toBeGreaterThan(BURST_BUDGET_MS);
    expect(scheduledAt(0.5, [TRAP, TURN_STARTED, TURN_AUTO_ENDED])).toEqual(slowed);
  });

  it("B4 the settings are read again at every enqueue", () => {
    const clock = fakeClock();
    let speed = 1;
    const queue = createAnimationQueue({
      schedule: clock.schedule,
      reducedMotion: false,
      settings: () => ({ speed, motion: "system" }),
    });

    queue.enqueue([TRAP], fullBoardView());
    clock.flush();
    speed = 2;
    queue.enqueue([TRAP], fullBoardView());
    clock.flush();
    speed = 0.5;
    queue.enqueue([TRAP], fullBoardView());
    clock.flush();

    expect(clock.scheduled()).toEqual([700, 350, 1400]);
  });

  it("B4 zero-duration entries stay unscheduled at every speed", () => {
    for (const speed of [0.5, 1, 2]) {
      expect(scheduledAt(speed, [GAME_OVER]), `speed ${speed}`).toEqual([]);
    }
  });

  it("B4 every entry of a long burst stays between MIN_ENTRY_MS and its speed-scaled duration", () => {
    const events = longStream(3);
    const timed = planEntries(events, fullBoardView(), false).filter((e) => e.durationMs > 0);
    const scheduled = scheduledAt(2, events);
    expect(scheduled).toHaveLength(timed.length);
    for (const [index, ms] of scheduled.entries()) {
      expect(ms).toBeGreaterThanOrEqual(MIN_ENTRY_MS);
      expect(ms).toBeLessThanOrEqual(scaleForSpeed(timed[index]?.durationMs ?? 0, 2));
    }
  });
});

/* ------------------------------------------------------------------------------------------- *
 * B5: the reduce setting
 * ------------------------------------------------------------------------------------------- */

describe("B5 the motion reduce setting", () => {
  it("B5 motion reduce drains a long stream synchronously: no timer and one onSettled", () => {
    const clock = fakeClock();
    const onSettled = vi.fn();
    const queue = createAnimationQueue({
      schedule: clock.schedule,
      reducedMotion: false,
      onSettled,
      settings: at(1, "reduce"),
    });
    const seen = listen(queue);

    queue.enqueue(longStream(6), fullBoardView());

    expect(clock.schedule).not.toHaveBeenCalled();
    expect(queue.pending()).toBe(0);
    expect(queue.inFlight()).toBeNull();
    expect(queue.animating().size).toBe(0);
    expect(queue.idle()).toBe(true);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(kinds(seen)).toEqual(["idle"]);
  });

  it("B5 reduce ignores the speed setting: nothing is scheduled at any speed", () => {
    for (const speed of [0.5, 2, 5]) {
      const clock = fakeClock();
      const queue = createAnimationQueue({ schedule: clock.schedule, reducedMotion: false, settings: at(speed, "reduce") });
      queue.enqueue([TRAP, TURN_STARTED, MANA], fullBoardView());
      expect(clock.schedule, `speed ${speed}`).not.toHaveBeenCalled();
      expect(queue.idle()).toBe(true);
    }
  });

  it("B5 switching the setting to reduce between enqueues stops scheduling from the next enqueue", () => {
    const clock = fakeClock();
    const onSettled = vi.fn();
    let motion: FxSettings["motion"] = "system";
    const queue = createAnimationQueue({
      schedule: clock.schedule,
      reducedMotion: false,
      onSettled,
      settings: () => ({ speed: 1, motion }),
    });

    queue.enqueue([TRAP], fullBoardView());
    clock.flush();
    expect(clock.scheduled()).toEqual([700]);

    motion = "reduce";
    queue.enqueue(longStream(2), fullBoardView());
    expect(clock.scheduled()).toEqual([700]);
    expect(queue.idle()).toBe(true);
    expect(onSettled).toHaveBeenCalledTimes(2);
  });

  it("B5 a motion value other than reduce does not reduce motion", () => {
    const clock = fakeClock();
    const queue = createAnimationQueue({
      schedule: clock.schedule,
      reducedMotion: false,
      settings: () => ({ speed: 1, motion: "never" as FxSettings["motion"] }),
    });
    queue.enqueue([TRAP], fullBoardView());
    expect(clock.scheduled()).toEqual([700]);
  });

  it("B5 reducedMotionNow is the media query OR the reduce setting", () => {
    expect(reducedMotionNow({ motion: "system" })).toBe(false);
    expect(reducedMotionNow({ motion: "reduce" })).toBe(true);
    setReducedMotion(true);
    expect(reducedMotionNow({ motion: "system" })).toBe(true);
    expect(reducedMotionNow({ motion: "reduce" })).toBe(true);
  });

  it("B5 without arguments reducedMotionNow reads the stored settings", () => {
    expect(reducedMotionNow()).toBe(false);
    window.localStorage.setItem(FX_SETTINGS_KEY, JSON.stringify({ speed: 1, intensity: "normal", motion: "reduce" }));
    resetFxSettingsForTests();
    expect(reducedMotionNow()).toBe(true);
  });

  it("B5 unparsable stored settings do not reduce motion", () => {
    window.localStorage.setItem(FX_SETTINGS_KEY, "{motion: reduce");
    resetFxSettingsForTests();
    expect(reducedMotionNow()).toBe(false);
    const clock = fakeClock();
    const queue = createAnimationQueue({ schedule: clock.schedule, reducedMotion: false });
    queue.enqueue([TRAP], fullBoardView());
    expect(clock.scheduled()).toEqual([700]);
  });

  it("B5 a queue with no settings option reads the stored reduce setting", () => {
    window.localStorage.setItem(FX_SETTINGS_KEY, JSON.stringify({ speed: 1, intensity: "normal", motion: "reduce" }));
    resetFxSettingsForTests();
    const clock = fakeClock();
    const onSettled = vi.fn();
    const queue = createAnimationQueue({ schedule: clock.schedule, reducedMotion: false, onSettled });

    queue.enqueue(longStream(1), fullBoardView());

    expect(clock.schedule).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("B5 the media query still reduces motion when the setting says system", () => {
    setReducedMotion(true);
    const clock = fakeClock();
    const queue = createAnimationQueue({ schedule: clock.schedule, settings: at(1, "system") });
    queue.enqueue(longStream(1), fullBoardView());
    expect(clock.schedule).not.toHaveBeenCalled();
    expect(queue.idle()).toBe(true);
  });
});
