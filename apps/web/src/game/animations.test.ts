// BUILD M5-T4 acceptance: every `GameEvent["type"]` has a row (fail on a missing one); with
// `prefers-reduced-motion` every duration is 0 and a full game's event queue drains synchronously.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { GAME_EVENT_TYPES, type GameEvent, type GameEventType, type PlayerView } from "@jackioh/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ANIMATIONS,
  type AnimationEntry,
  animTestid,
  createAnimationQueue,
  durationFor,
  locateInstance,
  planEntries,
  prefersReducedMotion,
  targetFor,
} from "./animations";
import { testid } from "./contract";
import { baseView, fullBoardView } from "../test/fixtures";
import { setReducedMotion } from "../test/setup";

afterEach(() => {
  setReducedMotion(false);
});

/* ------------------------------------------------------------------------------------------- *
 * The BUILD M5-T4 duration column, copied literally. A drift in either direction fails.
 * ------------------------------------------------------------------------------------------- */

const BUILD_DURATIONS: Record<GameEventType, number> = {
  cardPlayed: 400,
  cardResolved: 150,
  summoned: 250,
  attackDeclared: 350,
  damage: 300,
  healed: 300,
  destroyed: 350,
  exiled: 350,
  bounced: 350,
  drawn: 250,
  radiantSet: 400,
  positionSwitched: 250,
  controlChanged: 450,
  trapFired: 700,
  promptOpened: 150,
  manaChanged: 150,
  turnStarted: 600,
  divineShieldLost: 250,
  fused: 500,
  rotated: 500,
  // BUILD's Duration column is "—" for `gameOver`: the overlay is terminal, so 0.
  gameOver: 0,
  healthLost: 300,
  enteredGraveyard: 150,
  burned: 400,
  discarded: 300,
  addedToHand: 250,
  shuffledIn: 300,
  buffed: 250,
  keywordGranted: 200,
  counterChanged: 200,
  transformed: 400,
  swapped: 500,
  locked: 250,
  attackCancelled: 350,
  turnEnded: 150,
  turnAutoEnded: 600,
  promptAnswered: 150,
  drawOffered: 150,
  drawAnswered: 300,
  costChanged: 200,
  modifierChanged: 200,
};

/* ------------------------------------------------------------------------------------------- *
 * One event of every type, so the table can be exercised end to end.
 * ------------------------------------------------------------------------------------------- */

const SAMPLES: { [K in GameEventType]: Extract<GameEvent, { type: K }> } = {
  cardPlayed: { type: "cardPlayed", player: "p1", instanceId: "c1", defId: "core-002", costPaid: 1 },
  cardResolved: { type: "cardResolved", player: "p1", instanceId: "c1", defId: "core-002", permanent: true },
  summoned: { type: "summoned", player: "p1", instanceId: "c1", defId: "core-002", row: "units", lane: 2 },
  damage: { type: "damage", sourceId: "u1", targetId: "hero-p2", amount: 4, combat: true },
  healthLost: { type: "healthLost", player: "p1", amount: 3 },
  healed: { type: "healed", targetId: "hero-p1", amount: 2 },
  divineShieldLost: { type: "divineShieldLost", instanceId: "u6" },
  destroyed: {
    type: "destroyed",
    instanceId: "u1",
    defId: "core-004",
    owner: "p1",
    attack: 2,
    maxHealth: 3,
    killerId: "u6",
  },
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
  radiantSet: {
    type: "radiantSet",
    instanceId: "u3",
    defId: "core-017",
    zone: { z: "field", player: "p1", row: "units", lane: 2 },
  },
  transformed: {
    type: "transformed",
    instanceId: "u3",
    fromDefId: "core-017",
    toDefId: "token-sheep",
    newInstanceId: "c90",
  },
  fused: { type: "fused", instanceIds: ["u1", "u2"], resultInstanceId: "c91", defId: "core-088" },
  positionSwitched: { type: "positionSwitched", instanceId: "u3", position: "DEF" },
  controlChanged: { type: "controlChanged", instanceId: "u6", controller: "p1", row: "units", lane: 4 },
  rotated: { type: "rotated", direction: "left" },
  swapped: { type: "swapped", what: "health" },
  locked: { type: "locked", player: "p2", row: "backrow", lane: 1 },
  trapFired: { type: "trapFired", instanceId: "b5", defId: "core-084", controller: "p1" },
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

const ALL_SAMPLES: GameEvent[] = GAME_EVENT_TYPES.map((t) => SAMPLES[t]);

/** A long stream: one of every type, many times over, so the drain test is a real workload. */
function longStream(rounds: number): GameEvent[] {
  const out: GameEvent[] = [];
  for (let i = 0; i < rounds; i += 1) out.push(...ALL_SAMPLES);
  return out;
}

/**
 * The stylesheet as text. The BUILD table's Animation column is only honoured if the keyframes
 * exist, so the test reads the file rather than trusting the table. Vitest stubs CSS imports
 * (`test.css` defaults to false, and `?raw` comes back empty), hence `node:fs`.
 */
const animationsCss: string = (() => {
  for (const candidate of ["src/game/animations.css", "apps/web/src/game/animations.css"]) {
    const path = resolve(process.cwd(), candidate);
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  throw new Error(`animations.css not found from ${process.cwd()}`);
})();

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
  };
}

/* ------------------------------------------------------------------------------------------- *
 * The table is total
 * ------------------------------------------------------------------------------------------- */

describe("ANIMATIONS covers every event type", () => {
  it("has exactly one row per GameEvent[\"type\"]", () => {
    const rows = Object.keys(ANIMATIONS).sort();
    const types = [...GAME_EVENT_TYPES].sort();

    const missing = types.filter((t) => !rows.includes(t));
    expect(missing, `animations.ts has no row for: ${missing.join(", ")}`).toEqual([]);

    const extra = rows.filter((t) => !types.includes(t as GameEventType));
    expect(extra, `animations.ts has rows for unknown event types: ${extra.join(", ")}`).toEqual([]);

    expect(rows).toEqual(types);
    expect(rows).toHaveLength(40);
  });

  it("gives every row an animation name and a testid template", () => {
    for (const type of GAME_EVENT_TYPES) {
      const row = ANIMATIONS[type];
      expect(row.animation, `${type} has no animation name`).toMatch(/^jk-[a-z-]+$/);
      expect(row.testid.length, `${type} has no testid template`).toBeGreaterThan(0);
      expect(typeof row.target, `${type} has no target resolver`).toBe("function");
    }
  });

  it("names a CSS animation that animations.css defines", () => {
    const css = animationsCss;
    for (const type of GAME_EVENT_TYPES) {
      expect(css, `animations.css has no @keyframes ${ANIMATIONS[type].animation}`).toContain(
        `@keyframes ${ANIMATIONS[type].animation}`,
      );
    }
  });

  it("collapses every duration under prefers-reduced-motion in CSS too", () => {
    const css = animationsCss;
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("animation-duration: 0s !important");
    expect(css).toContain("transition-duration: 0s !important");
    // Every duration scales by --anim-scale (0 under reduced motion, src/index.css).
    expect(css).toContain("var(--anim-scale)");
  });

  it("lunges at least 20px for attackDeclared", () => {
    const css = animationsCss;
    const distance = /--lunge-distance:\s*(\d+)px/.exec(css);
    expect(distance, "animations.css does not declare --lunge-distance").not.toBeNull();
    expect(Number(distance?.[1]), "the lunge must translate >= 20px (BUILD M5-T4)").toBeGreaterThanOrEqual(20);
    expect(css).toContain("@keyframes jk-lunge");
    expect(css).toMatch(/@keyframes jk-lunge[\s\S]*var\(--lunge-distance\)/);
  });
});

/* ------------------------------------------------------------------------------------------- *
 * Durations
 * ------------------------------------------------------------------------------------------- */

describe("durations", () => {
  it("matches the BUILD M5-T4 table exactly", () => {
    const actual = Object.fromEntries(GAME_EVENT_TYPES.map((t) => [t, ANIMATIONS[t].durationMs]));
    expect(actual).toEqual(BUILD_DURATIONS);
  });

  it("durationFor returns the table value with motion on", () => {
    for (const type of GAME_EVENT_TYPES) {
      expect(durationFor(type, false), type).toBe(BUILD_DURATIONS[type]);
    }
  });

  it("durationFor returns 0 for every type under reduced motion", () => {
    for (const type of GAME_EVENT_TYPES) {
      expect(durationFor(type, true), type).toBe(0);
    }
  });

  it("prefersReducedMotion reads the media query", () => {
    expect(prefersReducedMotion()).toBe(false);
    setReducedMotion(true);
    expect(prefersReducedMotion()).toBe(true);
  });

  it("prefersReducedMotion tolerates a host without matchMedia", () => {
    const original = window.matchMedia;
    Object.defineProperty(window, "matchMedia", { writable: true, value: undefined });
    try {
      expect(prefersReducedMotion()).toBe(false);
    } finally {
      Object.defineProperty(window, "matchMedia", { writable: true, value: original });
    }
  });
});

/* ------------------------------------------------------------------------------------------- *
 * Payload-dependent targets
 * ------------------------------------------------------------------------------------------- */

/** The fixture numbers its instance ids as it builds, so they are read off it, never guessed. */
function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`the fixture is missing ${what}`);
  return value;
}

function handIds(view: PlayerView): string[] {
  const hand = view.you.hand;
  if (!Array.isArray(hand)) throw new Error("the viewer's own hand should be full cards (SPEC §10.8)");
  return hand.map((c) => c.instanceId);
}

function faceUpBackrowIds(view: PlayerView): string[] {
  return view.you.backrow.flatMap((slot) =>
    slot !== null && slot.faceDown === false ? [slot.instanceId] : [],
  );
}

describe("target resolution", () => {
  const view: PlayerView = fullBoardView();
  const YOUR_UNIT = must(view.you.units[0], "your unit in lane 0").instanceId;
  const YOUR_UNIT_1 = must(view.you.units[1], "your unit in lane 1").instanceId;
  const YOUR_UNIT_2 = must(view.you.units[2], "your unit in lane 2").instanceId;
  const ENEMY_UNIT = must(view.opponent.units[0], "the opponent's unit in lane 0").instanceId;
  const HAND_CARD = must(handIds(view)[0], "a card in the viewer's hand");
  // The fixture's last face-up backrow slot is the viewer's own Trap, in lane 4.
  const YOUR_TRAP = must(faceUpBackrowIds(view).at(-1), "a face-up trap in the viewer's backrow");

  it("damage on a hero resolves to hero-<side>", () => {
    expect(targetFor({ type: "damage", sourceId: "u1", targetId: "hero-p1", amount: 3, combat: true }, view)).toBe(
      testid.hero("you"),
    );
    expect(targetFor({ type: "damage", sourceId: "u1", targetId: "hero-p2", amount: 3, combat: true }, view)).toBe(
      testid.hero("opponent"),
    );
  });

  it("damage on a unit resolves to card-<targetId>", () => {
    expect(targetFor({ type: "damage", sourceId: null, targetId: ENEMY_UNIT, amount: 1, combat: false }, view)).toBe(
      testid.card(ENEMY_UNIT),
    );
    // An instance that is not on this seat's board resolves to nothing rather than a wrong element.
    expect(targetFor({ type: "damage", sourceId: null, targetId: "nope", amount: 1, combat: false }, view)).toBeNull();
  });

  it("healed on a hero resolves to hero-<side>", () => {
    expect(targetFor({ type: "healed", targetId: "hero-p2", amount: 5 }, view)).toBe(testid.hero("opponent"));
    expect(targetFor({ type: "healed", targetId: YOUR_UNIT_1, amount: 5 }, view)).toBe(testid.card(YOUR_UNIT_1));
  });

  it("summoned resolves to the landing zone", () => {
    expect(
      targetFor({ type: "summoned", player: "p1", instanceId: "c1", defId: "core-002", row: "units", lane: 3 }, view),
    ).toBe(testid.zone("you", "units", 3));
    expect(
      targetFor(
        { type: "summoned", player: "p2", instanceId: "c1", defId: "core-002", row: "backrow", lane: 0 },
        view,
      ),
    ).toBe(testid.zone("opponent", "backrow", 0));
  });

  it("controlChanged resolves to the new controller's zone", () => {
    expect(
      targetFor({ type: "controlChanged", instanceId: ENEMY_UNIT, controller: "p1", row: "units", lane: 4 }, view),
    ).toBe(testid.zone("you", "units", 4));
    expect(
      targetFor({ type: "controlChanged", instanceId: YOUR_UNIT_1, controller: "p2", row: "units", lane: 1 }, view),
    ).toBe(testid.zone("opponent", "units", 1));
  });

  it("locked resolves to the locked zone", () => {
    expect(targetFor({ type: "locked", player: "p1", row: "backrow", lane: 2 }, view)).toBe(
      testid.zone("you", "backrow", 2),
    );
    expect(targetFor({ type: "locked", player: "p2", row: "units", lane: 1 }, view)).toBe(
      testid.zone("opponent", "units", 1),
    );
  });

  it("manaChanged resolves to the right crystal tray", () => {
    expect(targetFor({ type: "manaChanged", player: "p1", current: 2, max: 4 }, view)).toBe(animTestid.mana("you"));
    expect(targetFor({ type: "manaChanged", player: "p2", current: 0, max: 3 }, view)).toBe(
      animTestid.mana("opponent"),
    );
  });

  it("turnStarted resolves to the banner for either player", () => {
    expect(targetFor({ type: "turnStarted", player: "p1", turn: 3 }, view)).toBe(testid.banner);
    expect(targetFor({ type: "turnStarted", player: "p2", turn: 4 }, view)).toBe(testid.banner);
    expect(targetFor({ type: "turnAutoEnded", player: "p2", turn: 4 }, view)).toBe(testid.banner);
  });

  it("drawOffered shows the toast on the opponent's seat only", () => {
    // p1 is the viewer. p1 offering: p1's own seat shows no toast.
    expect(targetFor({ type: "drawOffered", player: "p1" }, view)).toBeNull();
    // p2 offering: the viewer (p2's opponent) is the seat that sees the toast.
    expect(targetFor({ type: "drawOffered", player: "p2" }, view)).toBe(animTestid.drawToast);
    // The resolution is visible to both seats.
    expect(targetFor({ type: "drawAnswered", player: "p1", accept: true }, view)).toBe(animTestid.drawToast);
    expect(targetFor({ type: "drawAnswered", player: "p2", accept: false }, view)).toBe(animTestid.drawToast);
  });

  it("gameOver resolves to the result overlay", () => {
    expect(targetFor({ type: "gameOver", winner: "draw", reason: "turn-cap" }, view)).toBe(testid.result);
    expect(targetFor({ type: "gameOver", winner: "p2", reason: "concede" }, view)).toBe(testid.result);
  });

  it("promptOpened animates a modal only on the seat holding the prompt", () => {
    expect(targetFor({ type: "promptOpened", player: "p1", choiceId: "ch1", kind: "discover" }, view)).toBe(
      animTestid.prompt,
    );
    expect(targetFor({ type: "promptOpened", player: "p2", choiceId: "ch1", kind: "discover" }, view)).toBeNull();
    expect(targetFor({ type: "promptAnswered", player: "p1", choiceId: "ch1" }, view)).toBe(animTestid.prompt);
    expect(targetFor({ type: "promptAnswered", player: "p2", choiceId: "ch1" }, view)).toBeNull();
  });

  it("cardPlayed animates the viewer's hand card and the opponent's hand region", () => {
    expect(
      targetFor({ type: "cardPlayed", player: "p1", instanceId: HAND_CARD, defId: "core-002", costPaid: 1 }, view),
    ).toBe(testid.handCard(HAND_CARD));
    expect(
      targetFor({ type: "cardPlayed", player: "p2", instanceId: "hidden", defId: "core-002", costPaid: 1 }, view),
    ).toBe(animTestid.hand("opponent"));
  });

  it("piles stand in for cards that are not rendered", () => {
    expect(targetFor({ type: "drawn", player: "p2", instanceId: "zz", defId: "core-001" }, view)).toBe(
      animTestid.library("opponent"),
    );
    expect(targetFor({ type: "enteredGraveyard", instanceId: "zz", defId: "core-001", owner: "p1" }, view)).toBe(
      animTestid.graveyard("you"),
    );
    expect(targetFor({ type: "burned", instanceId: "zz", defId: "core-001", owner: "p2" }, view)).toBe(
      animTestid.hand("opponent"),
    );
    expect(targetFor({ type: "exiled", instanceId: "zz", defId: "core-001", owner: "p1" }, view)).toBe(
      animTestid.exile("you"),
    );
    expect(targetFor({ type: "shuffledIn", player: "p1", instanceId: "zz", defId: "core-001", position: 0 }, view)).toBe(
      animTestid.library("you"),
    );
    expect(targetFor({ type: "modifierChanged", player: "p2", modifierId: "m1", added: true }, view)).toBe(
      animTestid.modifiers("opponent"),
    );
  });

  it("trapFired falls back to the controller's backrow when the trap is face-down (FINDING)", () => {
    // The viewer's own face-up trap has an element.
    expect(targetFor({ type: "trapFired", instanceId: YOUR_TRAP, defId: "core-084", controller: "p1" }, view)).toBe(
      testid.card(YOUR_TRAP),
    );
    // An opponent's set trap renders as `{ faceDown: true }` with no instanceId (SPEC §10.8) and
    // `trapFired` carries no row/lane, so no lane-accurate element can be derived.
    expect(targetFor({ type: "trapFired", instanceId: "secret", defId: "core-084", controller: "p2" }, view)).toBe(
      animTestid.backrow("opponent"),
    );
  });

  it("radiantSet follows the zone in the payload", () => {
    expect(
      targetFor(
        {
          type: "radiantSet",
          instanceId: YOUR_UNIT_1,
          defId: "core-011",
          zone: { z: "field", player: "p1", row: "units", lane: 1 },
        },
        view,
      ),
    ).toBe(testid.card(YOUR_UNIT_1));
    expect(
      targetFor(
        { type: "radiantSet", instanceId: "hidden", defId: "core-011", zone: { z: "hand", player: "p2" } },
        view,
      ),
    ).toBe(animTestid.hand("opponent"));
    expect(
      targetFor(
        { type: "radiantSet", instanceId: "hidden", defId: "core-011", zone: { z: "graveyard", player: "p1" } },
        view,
      ),
    ).toBe(animTestid.graveyard("you"));
  });

  it("fused animates the first merging card that is on the board", () => {
    expect(
      targetFor({ type: "fused", instanceIds: ["gone", YOUR_UNIT_2], resultInstanceId: "c91", defId: "x" }, view),
    ).toBe(testid.card(YOUR_UNIT_2));
  });

  it("board-wide events animate the board", () => {
    expect(targetFor({ type: "rotated", direction: "left" }, view)).toBe(testid.board);
    expect(targetFor({ type: "swapped", what: "library" }, view)).toBe(testid.board);
  });

  it("turnEnded animates the end-turn button", () => {
    expect(targetFor({ type: "turnEnded", player: "p1", turn: 3, unspentMana: 0 }, view)).toBe(testid.endTurn);
  });

  it("locateInstance finds units, face-up backrow and the viewer's hand, and nothing else", () => {
    expect(locateInstance(view, YOUR_UNIT)).toBe(testid.card(YOUR_UNIT));
    expect(locateInstance(view, ENEMY_UNIT)).toBe(testid.card(ENEMY_UNIT));
    expect(locateInstance(view, YOUR_TRAP)).toBe(testid.card(YOUR_TRAP));
    expect(locateInstance(view, HAND_CARD)).toBe(testid.handCard(HAND_CARD));
    expect(locateInstance(view, "nope")).toBeNull();
    // A face-down backrow slot carries no instanceId at all (SPEC §10.8), and an empty view has
    // nothing to find.
    expect(locateInstance(baseView(), HAND_CARD)).toBeNull();
  });

  it("resolves a target for every event type without throwing", () => {
    for (const type of GAME_EVENT_TYPES) {
      expect(() => targetFor(SAMPLES[type], view), type).not.toThrow();
    }
  });
});

/* ------------------------------------------------------------------------------------------- *
 * Planning and the cardPlayed + summoned collapse
 * ------------------------------------------------------------------------------------------- */

describe("planEntries", () => {
  const view: PlayerView = fullBoardView();

  it("plays cardPlayed + summoned for the same card as one motion", () => {
    const events: GameEvent[] = [
      { type: "cardPlayed", player: "p1", instanceId: "c1", defId: "core-002", costPaid: 1 },
      { type: "summoned", player: "p1", instanceId: "c1", defId: "core-002", row: "units", lane: 2 },
    ];
    const entries = planEntries(events, view, false);

    expect(entries).toHaveLength(1);
    const entry = entries[0] as AnimationEntry;
    expect(entry.events).toHaveLength(2);
    expect(entry.type).toBe("cardPlayed");
    // One motion, one span of time: the pair takes the `cardPlayed` duration, not the sum.
    expect(entry.durationMs).toBe(BUILD_DURATIONS.cardPlayed);
    // The hand card reports `cardPlayed` and the landing zone reports `summoned`: the card
    // leaving the hand and scaling into the zone are the two halves of the same motion.
    expect([...entry.frames]).toEqual([
      [testid.handCard("c1"), "cardPlayed"],
      [testid.zone("you", "units", 2), "summoned"],
    ]);
  });

  it("does not collapse a summoned for a different card", () => {
    const entries = planEntries(
      [
        { type: "cardPlayed", player: "p1", instanceId: "c1", defId: "core-002", costPaid: 1 },
        { type: "summoned", player: "p1", instanceId: "other", defId: "core-002", row: "units", lane: 2 },
      ],
      view,
      false,
    );
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.durationMs)).toEqual([BUILD_DURATIONS.cardPlayed, BUILD_DURATIONS.summoned]);
  });

  it("does not collapse a summoned that is not immediately after its play", () => {
    const entries = planEntries(
      [
        { type: "cardPlayed", player: "p1", instanceId: "c1", defId: "core-002", costPaid: 1 },
        { type: "manaChanged", player: "p1", current: 1, max: 4 },
        { type: "summoned", player: "p1", instanceId: "c1", defId: "core-002", row: "units", lane: 2 },
      ],
      view,
      false,
    );
    expect(entries).toHaveLength(3);
  });

  it("collapses a bare summoned (Recruit, Reborn, a token) into its own entry", () => {
    const entries = planEntries(
      [{ type: "summoned", player: "p2", instanceId: "t1", defId: "token-sheep", row: "units", lane: 0 }],
      view,
      false,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.durationMs).toBe(BUILD_DURATIONS.summoned);
  });

  it("zeroes every duration under reduced motion", () => {
    for (const entry of planEntries(longStream(2), view, true)) {
      expect(entry.durationMs, entry.type).toBe(0);
    }
  });
});

/* ------------------------------------------------------------------------------------------- *
 * The runner
 * ------------------------------------------------------------------------------------------- */

describe("createAnimationQueue", () => {
  const view: PlayerView = fullBoardView();

  it("drains a full game's event queue synchronously under reduced motion", () => {
    setReducedMotion(true);
    const clock = fakeClock();
    const onSettled = vi.fn();
    const queue = createAnimationQueue({ schedule: clock.schedule, onSettled });

    const events = longStream(6); // 240 events, every type six times over.
    expect(events.length).toBeGreaterThanOrEqual(200);

    queue.enqueue(events, view);

    // Everything happened inside `enqueue`: nothing is queued, nothing is in flight, nothing is
    // animating and no timer was ever scheduled (BUILD M5-T4 acceptance).
    expect(clock.schedule).not.toHaveBeenCalled();
    expect(queue.pending()).toBe(0);
    expect(queue.inFlight()).toBeNull();
    expect(queue.animating().size).toBe(0);
    expect(queue.idle()).toBe(true);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("reads prefers-reduced-motion from the media query when not told", () => {
    setReducedMotion(true);
    const clock = fakeClock();
    const queue = createAnimationQueue({ schedule: clock.schedule });
    queue.enqueue(ALL_SAMPLES, view);
    expect(clock.schedule).not.toHaveBeenCalled();
    expect(queue.idle()).toBe(true);
  });

  it("schedules once per entry, with that entry's duration", () => {
    const clock = fakeClock();
    const queue = createAnimationQueue({ schedule: clock.schedule, reducedMotion: false });

    const events: GameEvent[] = [
      { type: "manaChanged", player: "p1", current: 1, max: 4 },
      { type: "damage", sourceId: "u1", targetId: "u6", amount: 2, combat: true },
      { type: "turnStarted", player: "p1", turn: 4 },
    ];
    queue.enqueue(events, view);

    // The head starts immediately; each later entry is scheduled as the one before it finishes.
    expect(clock.calls.map((c) => c.ms)).toEqual([BUILD_DURATIONS.manaChanged]);
    clock.tick();
    expect(clock.calls.map((c) => c.ms)).toEqual([BUILD_DURATIONS.damage]);
    clock.tick();
    expect(clock.calls.map((c) => c.ms)).toEqual([BUILD_DURATIONS.turnStarted]);
    clock.tick();

    expect(clock.schedule).toHaveBeenCalledTimes(3);
    expect(clock.schedule.mock.calls.map((c) => c[1])).toEqual([
      BUILD_DURATIONS.manaChanged,
      BUILD_DURATIONS.damage,
      BUILD_DURATIONS.turnStarted,
    ]);
    expect(queue.idle()).toBe(true);
  });

  it("schedules exactly one timer per non-zero-duration entry over a long stream", () => {
    const clock = fakeClock();
    const queue = createAnimationQueue({ schedule: clock.schedule, reducedMotion: false });
    const events = longStream(3);
    const entries = planEntries(events, view, false);
    const timed = entries.filter((e) => e.durationMs > 0);

    queue.enqueue(events, view);
    clock.flush();

    expect(clock.schedule).toHaveBeenCalledTimes(timed.length);
    expect(clock.schedule.mock.calls.map((c) => c[1])).toEqual(timed.map((e) => e.durationMs));
    expect(queue.idle()).toBe(true);
  });

  it("reports testid → eventType while an entry is in flight", () => {
    const clock = fakeClock();
    const queue = createAnimationQueue({ schedule: clock.schedule, reducedMotion: false });

    queue.enqueue(
      [
        { type: "damage", sourceId: "u1", targetId: "u6", amount: 2, combat: true },
        { type: "locked", player: "p1", row: "backrow", lane: 3 },
      ],
      view,
    );

    expect([...queue.animating()]).toEqual([[testid.card("u6"), "damage"]]);
    expect(queue.pending()).toBe(1);

    clock.tick();
    expect([...queue.animating()]).toEqual([[testid.zone("you", "backrow", 3), "locked"]]);

    clock.tick();
    expect(queue.animating().size).toBe(0);
  });

  it("reports both halves of the collapsed play while the one motion is in flight", () => {
    const clock = fakeClock();
    const queue = createAnimationQueue({ schedule: clock.schedule, reducedMotion: false });

    queue.enqueue(
      [
        { type: "cardPlayed", player: "p1", instanceId: "c1", defId: "core-002", costPaid: 1 },
        { type: "summoned", player: "p1", instanceId: "c1", defId: "core-002", row: "units", lane: 2 },
      ],
      view,
    );

    expect(clock.schedule).toHaveBeenCalledTimes(1);
    expect(clock.schedule.mock.calls[0]?.[1]).toBe(BUILD_DURATIONS.cardPlayed);
    expect([...queue.animating()]).toEqual([
      [testid.handCard("c1"), "cardPlayed"],
      [testid.zone("you", "units", 2), "summoned"],
    ]);
    expect(queue.inFlight()?.events).toHaveLength(2);

    clock.tick();
    expect(queue.idle()).toBe(true);
  });

  it("skips zero-duration entries without a timer (gameOver)", () => {
    const clock = fakeClock();
    const onSettled = vi.fn();
    const queue = createAnimationQueue({ schedule: clock.schedule, reducedMotion: false, onSettled });

    queue.enqueue([{ type: "gameOver", winner: "p1", reason: "hero-death" }], view);

    expect(clock.schedule).not.toHaveBeenCalled();
    expect(queue.idle()).toBe(true);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("notifies subscribers on every change and unsubscribes", () => {
    const clock = fakeClock();
    const queue = createAnimationQueue({ schedule: clock.schedule, reducedMotion: false });
    const seen: number[] = [];
    const off = queue.subscribe(() => {
      seen.push(queue.animating().size);
    });

    queue.enqueue([{ type: "manaChanged", player: "p1", current: 1, max: 4 }], view);
    expect(seen).toEqual([1]);
    clock.tick();
    expect(seen).toEqual([1, 0]);

    off();
    queue.enqueue([{ type: "manaChanged", player: "p1", current: 0, max: 4 }], view);
    expect(seen).toEqual([1, 0]);
  });

  it("drain finishes everything at once and stale timers cannot resurrect it", () => {
    const clock = fakeClock();
    const onSettled = vi.fn();
    const queue = createAnimationQueue({ schedule: clock.schedule, reducedMotion: false, onSettled });

    queue.enqueue(longStream(1), view);
    expect(queue.pending()).toBeGreaterThan(0);

    queue.drain();
    expect(queue.pending()).toBe(0);
    expect(queue.animating().size).toBe(0);
    expect(queue.idle()).toBe(true);
    expect(onSettled).toHaveBeenCalledTimes(1);

    // The timer left over from the entry that was in flight is a no-op.
    const before = clock.schedule.mock.calls.length;
    clock.flush();
    expect(clock.schedule.mock.calls.length).toBe(before);
    expect(queue.idle()).toBe(true);
  });

  it("reset clears the queue without firing onSettled", () => {
    const clock = fakeClock();
    const onSettled = vi.fn();
    const queue = createAnimationQueue({ schedule: clock.schedule, reducedMotion: false, onSettled });

    queue.enqueue(longStream(1), view);
    queue.reset();

    expect(queue.idle()).toBe(true);
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("appends a second batch behind the one in flight", () => {
    const clock = fakeClock();
    const queue = createAnimationQueue({ schedule: clock.schedule, reducedMotion: false });

    queue.enqueue([{ type: "turnStarted", player: "p1", turn: 1 }], view);
    queue.enqueue([{ type: "turnEnded", player: "p1", turn: 1, unspentMana: 0 }], view);

    expect(queue.pending()).toBe(1);
    expect(queue.inFlight()?.type).toBe("turnStarted");
    clock.tick();
    expect(queue.inFlight()?.type).toBe("turnEnded");
    clock.tick();
    expect(queue.idle()).toBe(true);
  });

  it("defaults its timer to setTimeout", async () => {
    vi.useFakeTimers();
    try {
      const onSettled = vi.fn();
      const queue = createAnimationQueue({ reducedMotion: false, onSettled });
      queue.enqueue([{ type: "manaChanged", player: "p1", current: 1, max: 4 }], view);
      expect(queue.animating().size).toBe(1);
      await vi.advanceTimersByTimeAsync(BUILD_DURATIONS.manaChanged);
      expect(queue.idle()).toBe(true);
      expect(onSettled).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
