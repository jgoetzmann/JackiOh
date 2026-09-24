// docs/polish/1-animations.md, behaviours B8 to B22: the cue planner (S6) and its recipe table (S7).
//
// R200 (the effects layer paces nothing) and R202 (effects draw from the redacted stream only) are
// named here; the rulings index points at this file for both.
//
// Burst `count` and `power` come from `cues.ts`'s own TUNING table, so recipe comparisons drop those
// two fields and B9 checks how counts scale instead. Everything else in a cue (kind, preset, anchor,
// spread, delay, duration, tone, amount, text) is S7's and is compared exactly. Within one recipe the
// cues are compared as a set: S7 lists what is planned, not in which order.

import type { GameEvent, PlayerView } from "@jackioh/shared";
import { describe, expect, it, vi } from "vitest";

import { ANIMATIONS, MIN_ENTRY_MS, planEntries, type AnimationEntry } from "../game/animations.ts";
import { testid, type Side } from "../game/contract.ts";
import { baseView, emptySide, fullBoardView, withEvents } from "../test/fixtures.ts";
import {
  FX_ARROWS_TAIL_MS,
  FX_BANNER_TAIL_MS,
  FX_BURN_AT,
  FX_CENTER,
  FX_CRACK_TAIL_MS,
  FX_DEATH_EMBER_AT,
  FX_DEATH_SMOKE_AT,
  FX_FUSE_FLIGHT_FRACTION,
  FX_HANDOVER_BANNER_MS,
  FX_HEAL_SPLAT_AT,
  FX_INTENSITY_SCALE,
  FX_LETHAL_LEAD_MAX_MS,
  FX_MANA_MAX_SPARKS,
  FX_MANA_STAGGER_MS,
  FX_MAX_PARTICLE_LIFE_MS,
  FX_MAX_TAIL_MS,
  FX_MEMORY_LIMIT,
  FX_MIND_CONTROL_FLIGHT_FRACTION,
  FX_PROJECTILE_FLIGHT_FRACTION,
  FX_RADIANT_BURST_AT,
  FX_RAYS_TAIL_MS,
  FX_RESULT_MS,
  FX_RING_MS,
  FX_SLAM_AT,
  FX_SPLAT_HOLD_MS,
  FX_TRAP_BURST_AT,
} from "./constants.ts";
import { delayCues, planFx, planHandover, planLethal, planResult, sourceAnchor } from "./cues.ts";
import { createFxMemory } from "./memory.ts";
import type { FxAnchor, FxCardFacts, FxCue, FxPlanEnv, FxPoint } from "./types.ts";

/* ------------------------------------------------------------------------------------------- *
 * Fixture ids, read off the M5-T1 board rather than guessed
 * ------------------------------------------------------------------------------------------- */

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`the fixture is missing ${what}`);
  return value;
}

const VIEW: PlayerView = fullBoardView();

function unitId(side: Side, index: number): string {
  return must(VIEW[side].units[index], `${side} unit ${index}`).instanceId;
}

function handId(index: number): string {
  const hand = VIEW.you.hand;
  if (!Array.isArray(hand)) throw new Error("the viewer's own hand should be full cards");
  return must(hand[index], `hand card ${index}`).instanceId;
}

function backrowId(index: number): string {
  const slot = VIEW.you.backrow[index];
  if (slot === null || slot === undefined || slot.faceDown) throw new Error(`backrow ${index} is not face-up`);
  return slot.instanceId;
}

/** The viewer's lane-1 unit: Taunt only. */
const MINE = unitId("you", 0);
/** The viewer's lane-2 unit: every keyword, Poisonous included. */
const POISONER = unitId("you", 1);
const MINE_3 = unitId("you", 2);
/** The opponent's lane-1 unit: Divine Shield only. */
const ENEMY = unitId("opponent", 0);
const ENEMY_2 = unitId("opponent", 1);
const HAND = handId(0);
const HAND_2 = handId(1);
/** The viewer's face-up Field Spell in backrow lane 1. */
const FIELD_SPELL = backrowId(0);
/** The viewer's face-up Trap in backrow lane 5. */
const MY_TRAP = backrowId(4);

/* ------------------------------------------------------------------------------------------- *
 * Anchors and expected cues, in S7's notation
 * ------------------------------------------------------------------------------------------- */

type Loose = Record<string, unknown>;

const T = FX_MAX_TAIL_MS;
/** A second D for every row: nothing it is multiplied by lands on a .5 tie. */
const ODD_D = 732;
const r = Math.round;

function tid(value: string, point?: FxPoint): FxAnchor {
  return point === undefined ? { kind: "testid", testid: value } : { kind: "testid", testid: value, at: point };
}

const FOOT: FxPoint = { x: 0.5, y: 1 };
const CENTER: FxAnchor = { kind: "viewport", at: { x: FX_CENTER.x, y: FX_CENTER.y } };
const cardT = (id: string): FxAnchor => tid(testid.card(id));
const handCardT = (id: string): FxAnchor => tid(testid.handCard(id));
const heroT = (side: Side): FxAnchor => tid(testid.hero(side));
const zoneT = (side: Side, row: "units" | "backrow", lane: number): FxAnchor => tid(testid.zone(side, row, lane));
const crystal = (side: Side, index: number): FxAnchor => ({ kind: "crystal", side, index });

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function burst(preset: string, at: FxAnchor, spread: string, delayMs: number): Loose {
  return { kind: "burst", preset, at, spread, delayMs };
}
function ring(preset: string, at: FxAnchor, delayMs: number, D: number): Loose {
  return { kind: "ring", preset, at, delayMs, durationMs: Math.min(FX_RING_MS, D - delayMs + T) };
}
function rays(tone: string, at: FxAnchor, delayMs: number, D: number): Loose {
  return { kind: "rays", tone, at, delayMs, durationMs: D - delayMs + FX_RAYS_TAIL_MS };
}
function splat(tone: string, amount: number, at: FxAnchor, delayMs: number, D: number): Loose {
  return { kind: "splat", tone, amount, at, delayMs, durationMs: D - delayMs + FX_SPLAT_HOLD_MS };
}
function crack(at: FxAnchor, delayMs: number, D: number): Loose {
  return { kind: "crack", at, delayMs, durationMs: D - delayMs + FX_CRACK_TAIL_MS };
}
function sheen(at: FxAnchor, D: number): Loose {
  return { kind: "sheen", at, delayMs: 0, durationMs: D };
}
function ghost(from: FxAnchor, to: FxAnchor, D: number): Loose {
  return { kind: "ghost", from, to, delayMs: 0, durationMs: D };
}
function arrows(direction: "up" | "down", at: FxAnchor, D: number): Loose {
  return { kind: "arrows", direction, at, delayMs: 0, durationMs: D + FX_ARROWS_TAIL_MS };
}
function projectile(preset: string, from: FxAnchor, to: FxAnchor, flightMs: number): Loose {
  return { kind: "projectile", preset, from, to, delayMs: 0, flightMs, density: 1 };
}
function shake(trauma: number, delayMs: number): Loose {
  return { kind: "shake", trauma: round6(trauma), delayMs };
}
function banner(text: string, tone: string, durationMs: number): Loose {
  return { kind: "banner", text, tone, delayMs: 0, durationMs };
}

/** A cue minus the TUNING-owned burst fields, with trauma rounded so float order cannot matter. */
function shape(cue: FxCue): Loose {
  if (cue.kind === "burst") {
    const { count: _count, power: _power, ...rest } = cue;
    return rest;
  }
  if (cue.kind === "shake") return { ...cue, trauma: round6(cue.trauma) };
  return { ...cue };
}

/** A key-sorted JSON string that ignores undefined fields, used only to order cues. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sortCues(cues: readonly Loose[]): Loose[] {
  return [...cues].sort((a, b) => (stable(a) < stable(b) ? -1 : stable(a) > stable(b) ? 1 : 0));
}

function expectCues(actual: readonly FxCue[], expected: readonly Loose[]): void {
  expect(sortCues(actual.map(shape))).toEqual(sortCues(expected));
}

function shakesOf(cues: readonly FxCue[]): number[] {
  return cues.flatMap((cue) => (cue.kind === "shake" ? [cue.trauma] : []));
}

/* ------------------------------------------------------------------------------------------- *
 * Planning helpers
 * ------------------------------------------------------------------------------------------- */

function envOf(over: Partial<FxPlanEnv> = {}): FxPlanEnv {
  return { intensity: FX_INTENSITY_SCALE.normal, card: () => undefined, memory: createFxMemory(), ...over };
}

function catalog(facts: Record<string, FxCardFacts>): FxPlanEnv["card"] {
  return (defId) => facts[defId];
}

function entryFor(events: readonly GameEvent[], view: PlayerView, D: number): AnimationEntry {
  const entries = planEntries(events, view, false);
  expect(entries, "these events should plan exactly one entry").toHaveLength(1);
  return { ...must(entries[0], "an entry"), durationMs: D };
}

type PlanOptions = { view?: PlayerView; env?: FxPlanEnv; prime?: readonly GameEvent[] };

/** What the FX layer does on `start`: remember the entry's events, then plan it (S6). */
function plan(events: readonly GameEvent[], D: number, options: PlanOptions = {}): FxCue[] {
  const view = withEvents(options.view ?? fullBoardView(), [...events]);
  const env = options.env ?? envOf();
  if (options.prime !== undefined) env.memory.remember(options.prime);
  const entry = entryFor(events, view, D);
  env.memory.remember(entry.events);
  return planFx(entry, view, env);
}

/** Runs `check` at the row's own table duration and at `ODD_D`. */
function forDs(type: GameEvent["type"], check: (D: number) => void): void {
  for (const D of [ANIMATIONS[type].durationMs, ODD_D]) check(D);
}

const dmg = (sourceId: string | null, targetId: string, amount: number, combat: boolean): GameEvent => ({
  type: "damage",
  sourceId,
  targetId,
  amount,
  combat,
});

const summon = (player: "p1" | "p2", instanceId: string, defId: string, row: "units" | "backrow", lane: number): GameEvent => ({
  type: "summoned",
  player,
  instanceId,
  defId,
  row,
  lane,
});

const played = (player: "p1" | "p2", instanceId: string, defId = "core-002"): GameEvent => ({
  type: "cardPlayed",
  player,
  instanceId,
  defId,
  costPaid: 1,
});

/* ------------------------------------------------------------------------------------------- *
 * One sample per recipe branch, for the property checks
 * ------------------------------------------------------------------------------------------- */

type Sample = { name: string; events: GameEvent[]; prime?: GameEvent[]; card?: FxPlanEnv["card"] };

const FACTS: Record<string, FxCardFacts> = {
  "core-002": { rarity: "Common", attack: 1, health: 2 },
  "core-090": { rarity: "Legendary", attack: 6, health: 6 },
  "core-095": { rarity: "Mythic", attack: 12, health: 12 },
  "core-040": { rarity: "Epic", attack: 5, health: 5 },
};

function samples(): Sample[] {
  return [
    { name: "the viewer casts from hand", events: [played("p1", HAND)] },
    { name: "the opponent casts", events: [played("p2", "hidden", "hidden")] },
    { name: "a Legendary is played and summoned", events: [played("p1", HAND, "core-090"), summon("p1", HAND, "core-090", "units", 3)], card: catalog(FACTS) },
    { name: "a Mythic is summoned", events: [summon("p2", "n7", "core-095", "units", 2)], card: catalog(FACTS) },
    { name: "an Epic is summoned", events: [summon("p1", "n9", "core-040", "units", 4)], card: catalog(FACTS) },
    { name: "a backrow card is set", events: [summon("p2", "hidden", "hidden", "backrow", 3)] },
    { name: "a spell burns a hero", events: [dmg(HAND, "hero-p2", 6, false)] },
    { name: "a poisonous ping", events: [dmg(POISONER, ENEMY, 3, false)] },
    { name: "a remembered caster deals damage", events: [dmg("s42", ENEMY_2, 4, false)], prime: [played("p2", "s42", "core-070")] },
    {
      name: "a remembered trap deals damage",
      events: [dmg("t77", "hero-p2", 5, false)],
      prime: [{ type: "trapFired", instanceId: "t77", defId: "core-084", controller: "p1", row: "backrow", lane: 3 }],
    },
    { name: "combat damage to a hero", events: [dmg(MINE, "hero-p2", 20, true)] },
    { name: "health lost", events: [{ type: "healthLost", player: "p1", amount: 3 }] },
    { name: "a hero is healed", events: [{ type: "healed", targetId: "hero-p1", amount: 5 }] },
    { name: "divine shield lost", events: [{ type: "divineShieldLost", instanceId: ENEMY }] },
    { name: "a unit is destroyed", events: [{ type: "destroyed", instanceId: MINE_3, defId: "core-017", owner: "p1", attack: 1, maxHealth: 6, killerId: null }] },
    { name: "a card is destroyed off the board", events: [{ type: "destroyed", instanceId: "gone", defId: "core-017", owner: "p2", attack: 1, maxHealth: 1, killerId: null }] },
    { name: "a unit is exiled", events: [{ type: "exiled", instanceId: ENEMY_2, defId: "core-013", owner: "p2" }] },
    { name: "a unit is bounced", events: [{ type: "bounced", instanceId: MINE_3, defId: "core-017", owner: "p1" }] },
    { name: "a card is burned", events: [{ type: "burned", instanceId: "hidden", defId: "hidden", owner: "p2" }] },
    { name: "a hand card is discarded", events: [{ type: "discarded", instanceId: HAND, defId: "core-002", owner: "p1" }] },
    { name: "a card is drawn", events: [{ type: "drawn", player: "p1", instanceId: "cY", defId: "core-055" }] },
    { name: "a card is added to hand", events: [{ type: "addedToHand", player: "p2", instanceId: "hidden", defId: "hidden" }] },
    { name: "a card is shuffled in", events: [{ type: "shuffledIn", player: "p1", instanceId: "cW", defId: "core-070", position: 3 }] },
    { name: "a buff", events: [{ type: "buffed", instanceId: MINE_3, attack: 2, health: 1 }] },
    { name: "a debuff", events: [{ type: "buffed", instanceId: ENEMY, attack: -2, health: 0 }] },
    { name: "divine shield granted", events: [{ type: "keywordGranted", instanceId: MINE_3, keyword: { kind: "Divine Shield" } }] },
    { name: "poisonous granted", events: [{ type: "keywordGranted", instanceId: MINE_3, keyword: { kind: "Poisonous" } }] },
    { name: "taunt granted", events: [{ type: "keywordGranted", instanceId: MINE_3, keyword: { kind: "Taunt" } }] },
    { name: "rush granted", events: [{ type: "keywordGranted", instanceId: MINE_3, keyword: { kind: "Rush" } }] },
    { name: "a plague counter", events: [{ type: "counterChanged", instanceId: ENEMY, counter: "plague", value: 2 }] },
    { name: "a grade counter", events: [{ type: "counterChanged", instanceId: MINE_3, counter: "grade", value: 1 }] },
    { name: "a cost change", events: [{ type: "costChanged", instanceId: HAND, cost: 0 }] },
    { name: "a modifier added", events: [{ type: "modifierChanged", player: "p2", modifierId: "m9", added: true }] },
    { name: "radiant on the field", events: [{ type: "radiantSet", instanceId: POISONER, defId: "core-011", zone: { z: "field", player: "p1", row: "units", lane: 2 } }] },
    { name: "radiant in the opponent's hand", events: [{ type: "radiantSet", instanceId: "hidden", defId: "hidden", zone: { z: "hand", player: "p2" } }] },
    { name: "a transform", events: [{ type: "transformed", instanceId: MINE_3, fromDefId: "core-017", toDefId: "token-sheep", newInstanceId: "c90" }] },
    { name: "a three-way fuse", events: [{ type: "fused", instanceIds: [MINE, POISONER, MINE_3], resultInstanceId: "c91", defId: "core-088" }] },
    { name: "mind control", events: [{ type: "controlChanged", instanceId: ENEMY, controller: "p1", row: "units", lane: 4 }] },
    { name: "a lock", events: [{ type: "locked", player: "p2", row: "units", lane: 2 }] },
    { name: "the viewer's trap fires", events: [{ type: "trapFired", instanceId: MY_TRAP, defId: "core-084", controller: "p1", row: "backrow", lane: 5 }] },
    { name: "a hidden trap fires", events: [{ type: "trapFired", instanceId: "hidden", defId: "hidden", controller: "p2", row: "backrow", lane: 4 }] },
    { name: "an attack is declared", events: [{ type: "attackDeclared", attackerId: MINE, targetId: ENEMY, forced: false }] },
    { name: "an attack is cancelled", events: [{ type: "attackCancelled", attackerId: MINE, targetId: ENEMY, byInstanceId: "b5" }] },
    { name: "the opponent's mana refills", events: [{ type: "manaChanged", player: "p2", current: 3, max: 3 }] },
    { name: "mana far past the spark cap", events: [{ type: "manaChanged", player: "p1", current: 30, max: 30 }] },
    { name: "the viewer's turn starts", events: [{ type: "turnStarted", player: "p1", turn: 5 }] },
    { name: "the opponent's turn starts", events: [{ type: "turnStarted", player: "p2", turn: 6 }] },
    { name: "a turn auto-ends", events: [{ type: "turnAutoEnded", player: "p1", turn: 5 }] },
  ];
}

function prepare(sample: Sample, intensity: number = FX_INTENSITY_SCALE.normal) {
  const view = withEvents(fullBoardView(), sample.events);
  const env = envOf({ intensity, card: sample.card ?? (() => undefined) });
  if (sample.prime !== undefined) env.memory.remember(sample.prime);
  const entry = entryFor(sample.events, view, ANIMATIONS[must(sample.events[0], "an event").type].durationMs);
  env.memory.remember(entry.events);
  return { entry, view, env };
}

function planSample(sample: Sample, D: number, intensity: number = FX_INTENSITY_SCALE.normal): FxCue[] {
  const { entry, view, env } = prepare(sample, intensity);
  return planFx({ ...entry, durationMs: D }, view, env);
}

/* ------------------------------------------------------------------------------------------- *
 * B8: R200, every cue lands inside its entry
 * ------------------------------------------------------------------------------------------- */

describe("B8 timing bounds", () => {
  it("R200 every planned cue starts inside its entry and ends within FX_MAX_TAIL_MS of the entry's end, for every D from MIN_ENTRY_MS to 1400 ms", () => {
    const problems: string[] = [];
    for (const sample of samples()) {
      const { entry, view, env } = prepare(sample);
      for (let D = MIN_ENTRY_MS; D <= 1400 && problems.length < 20; D += 1) {
        for (const cue of planFx({ ...entry, durationMs: D }, view, env)) {
          const where = `${sample.name} at D=${D}: ${JSON.stringify(cue)}`;
          if (!(cue.delayMs >= 0 && cue.delayMs <= D)) problems.push(`delay outside [0, D]: ${where}`);
          if (cue.kind === "projectile" && !(cue.delayMs + cue.flightMs <= D)) problems.push(`lands after the entry ends: ${where}`);
          if ("durationMs" in cue && !(cue.delayMs + cue.durationMs <= D + T)) problems.push(`outlives the tail: ${where}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("B8 every sample plans at least one cue, so the bounds above are not vacuous", () => {
    for (const sample of samples()) {
      expect(planSample(sample, MIN_ENTRY_MS).length, sample.name).toBeGreaterThan(0);
      expect(planSample(sample, 1400).length, sample.name).toBeGreaterThan(0);
    }
  });

  it("B8 every planned delay, flight and duration is a whole number of milliseconds", () => {
    for (const sample of samples()) {
      for (const D of [MIN_ENTRY_MS, 333, ODD_D, 1399]) {
        for (const cue of planSample(sample, D)) {
          const times = [cue.delayMs];
          if (cue.kind === "projectile") times.push(cue.flightMs);
          if ("durationMs" in cue) times.push(cue.durationMs);
          for (const ms of times) expect(Number.isInteger(ms), `${sample.name} at D=${D}: ${JSON.stringify(cue)}`).toBe(true);
        }
      }
    }
  });

  it("B8 the tail bound T is 900 ms and every tail constant fits inside it", () => {
    expect(FX_MAX_TAIL_MS).toBe(900);
    expect(FX_MAX_PARTICLE_LIFE_MS).toBeLessThanOrEqual(T);
    for (const tail of [FX_SPLAT_HOLD_MS, FX_RAYS_TAIL_MS, FX_ARROWS_TAIL_MS, FX_CRACK_TAIL_MS, FX_BANNER_TAIL_MS, FX_RING_MS]) {
      expect(tail).toBeLessThanOrEqual(T);
    }
  });
});

/* ------------------------------------------------------------------------------------------- *
 * B9: intensity
 * ------------------------------------------------------------------------------------------- */

describe("B9 intensity", () => {
  const LEVELS = [FX_INTENSITY_SCALE.low, FX_INTENSITY_SCALE.normal, FX_INTENSITY_SCALE.high] as const;

  it("B9 the intensity scale is off 0, low 0.45, normal 1, high 1.6", () => {
    expect(FX_INTENSITY_SCALE).toEqual({ off: 0, low: 0.45, normal: 1, high: 1.6 });
  });

  it("B9 burst counts grow with intensity: every burst low <= normal <= high, and the totals strictly", () => {
    const totals = [0, 0, 0];
    for (const sample of samples()) {
      const [low, normal, high] = LEVELS.map((level) => planSample(sample, 400, level));
      expect(low?.map((c) => c.kind), sample.name).toEqual(normal?.map((c) => c.kind));
      expect(high?.map((c) => c.kind), sample.name).toEqual(normal?.map((c) => c.kind));
      (normal ?? []).forEach((cue, index) => {
        if (cue.kind !== "burst") return;
        const lo = low?.[index];
        const hi = high?.[index];
        if (lo?.kind !== "burst" || hi?.kind !== "burst") throw new Error(`${sample.name}: bursts do not line up`);
        expect(lo.count, sample.name).toBeLessThanOrEqual(cue.count);
        expect(cue.count, sample.name).toBeLessThanOrEqual(hi.count);
        totals[0] = (totals[0] ?? 0) + lo.count;
        totals[1] = (totals[1] ?? 0) + cue.count;
        totals[2] = (totals[2] ?? 0) + hi.count;
      });
    }
    expect(totals[0]).toBeLessThan(totals[1] ?? 0);
    expect(totals[1]).toBeLessThan(totals[2] ?? 0);
  });

  it("B9 every burst count is a whole number of at least 1, even at low intensity", () => {
    for (const sample of samples()) {
      for (const level of LEVELS) {
        for (const cue of planSample(sample, 400, level)) {
          if (cue.kind !== "burst") continue;
          expect(Number.isInteger(cue.count), sample.name).toBe(true);
          expect(cue.count, sample.name).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });

  it("B9 shake trauma is the normal trauma times the intensity, capped at 1", () => {
    let checked = 0;
    for (const sample of samples()) {
      const normal = shakesOf(planSample(sample, 400, FX_INTENSITY_SCALE.normal));
      const low = shakesOf(planSample(sample, 400, FX_INTENSITY_SCALE.low));
      const high = shakesOf(planSample(sample, 400, FX_INTENSITY_SCALE.high));
      expect(low.length, sample.name).toBe(normal.length);
      expect(high.length, sample.name).toBe(normal.length);
      normal.forEach((trauma, index) => {
        expect(low[index], sample.name).toBeCloseTo(Math.min(1, trauma * FX_INTENSITY_SCALE.low), 6);
        expect(high[index], sample.name).toBeCloseTo(Math.min(1, trauma * FX_INTENSITY_SCALE.high), 6);
        checked += 1;
      });
    }
    expect(checked, "some samples must shake").toBeGreaterThan(3);
  });

  it("B9 a hero hit at high intensity is capped at trauma 1", () => {
    const cues = plan([dmg(MINE, "hero-p2", 6, true)], 300, { env: envOf({ intensity: FX_INTENSITY_SCALE.high }) });
    // 0.6 × 1.25 = 0.75 at normal; × 1.6 = 1.2, capped.
    expect(shakesOf(cues)).toEqual([1]);
  });

  it("B9 intensity 0 plans nothing for any sample", () => {
    for (const sample of samples()) {
      expect(planSample(sample, 400, FX_INTENSITY_SCALE.off), sample.name).toEqual([]);
    }
  });

  it("B9 a negative intensity plans nothing", () => {
    for (const sample of samples()) {
      expect(planSample(sample, 400, -1), sample.name).toEqual([]);
    }
  });
});

/* ------------------------------------------------------------------------------------------- *
 * B10 to B12: impact
 * ------------------------------------------------------------------------------------------- */

describe("B10 spell projectiles", () => {
  it("B10 a non-combat damage from a rendered unit flies an arcane projectile and lands every impact at the flight time", () => {
    forDs("damage", (D) => {
      const flight = r(FX_PROJECTILE_FLIGHT_FRACTION * D);
      expectCues(plan([dmg(MINE, ENEMY, 4, false)], D), [
        projectile("arcane", cardT(MINE), cardT(ENEMY), flight),
        burst("spark", cardT(ENEMY), "point", flight),
        splat("damage", 4, cardT(ENEMY), flight, D),
        shake(0.6, flight),
      ]);
    });
  });

  it("B10 combat damage flies nothing and impacts at 0", () => {
    forDs("damage", (D) => {
      const cues = plan([dmg(MINE, ENEMY, 4, true)], D);
      expect(cues.some((c) => c.kind === "projectile")).toBe(false);
      expectCues(cues, [burst("spark", cardT(ENEMY), "point", 0), splat("damage", 4, cardT(ENEMY), 0, D), shake(0.6, 0)]);
    });
  });

  it("B10 a source that resolves to its own target flies nothing", () => {
    expectCues(plan([dmg(ENEMY, ENEMY, 4, false)], 300), [
      burst("spark", cardT(ENEMY), "point", 0),
      splat("damage", 4, cardT(ENEMY), 0, 300),
      shake(0.6, 0),
    ]);
  });

  it("B10 a null or unknown source flies nothing and impacts at 0", () => {
    for (const source of [null, "nowhere"]) {
      expectCues(plan([dmg(source, ENEMY, 4, false)], 300), [
        burst("spark", cardT(ENEMY), "point", 0),
        splat("damage", 4, cardT(ENEMY), 0, 300),
        shake(0.6, 0),
      ]);
    }
  });

  it("B10 damage to a target the view does not render plans nothing", () => {
    expect(plan([dmg(MINE, "nowhere", 6, false)], 300)).toEqual([]);
    expect(plan([dmg(MINE, "nowhere", 6, true)], 300)).toEqual([]);
  });

  it("B10 the projectile preset follows its source: fire from a hand card, arcane from a backrow card", () => {
    const flight = r(FX_PROJECTILE_FLIGHT_FRACTION * 300);
    expectCues(plan([dmg(HAND, "hero-p2", 2, false)], 300), [
      projectile("fire", handCardT(HAND), heroT("opponent"), flight),
      burst("spark", heroT("opponent"), "point", flight),
      splat("damage", 2, heroT("opponent"), flight, 300),
    ]);
    expectCues(plan([dmg(FIELD_SPELL, ENEMY_2, 2, false)], 300), [
      projectile("arcane", cardT(FIELD_SPELL), cardT(ENEMY_2), flight),
      burst("spark", cardT(ENEMY_2), "point", flight),
      splat("damage", 2, cardT(ENEMY_2), flight, 300),
    ]);
  });
});

describe("B11 damage splats and shake", () => {
  it("B11 damage plans a damage splat with the event's amount and a spark burst at the target", () => {
    for (const amount of [1, 3, 6, 20]) {
      for (const [targetId, anchor] of [
        [ENEMY, cardT(ENEMY)],
        ["hero-p2", heroT("opponent")],
        ["hero-p1", heroT("you")],
      ] as const) {
        const cues = plan([dmg(MINE, targetId, amount, true)], 300);
        const shapes = cues.map(shape);
        expect(shapes, `${amount} on ${targetId}`).toContainEqual(splat("damage", amount, anchor, 0, 300));
        expect(shapes, `${amount} on ${targetId}`).toContainEqual(burst("spark", anchor, "point", 0));
      }
    }
  });

  it("B11 damage below 3 shakes nothing", () => {
    for (const amount of [1, 2]) {
      expect(shakesOf(plan([dmg(MINE, ENEMY, amount, true)], 300)), `unit ${amount}`).toEqual([]);
      expect(shakesOf(plan([dmg(MINE, "hero-p2", amount, true)], 300)), `hero ${amount}`).toEqual([]);
    }
  });

  it("B11 on a unit, trauma is 0.15 per damage from 3 up, capped at 0.8", () => {
    const trauma = (amount: number) => shakesOf(plan([dmg(MINE, ENEMY, amount, true)], 300)).map(round6);
    expect(trauma(3)).toEqual([0.45]);
    expect(trauma(4)).toEqual([0.6]);
    expect(trauma(5)).toEqual([0.75]);
    expect(trauma(6)).toEqual([0.8]);
    expect(trauma(20)).toEqual([0.8]);
  });

  it("B11 on a hero, trauma is multiplied by 1.25", () => {
    const trauma = (amount: number) => shakesOf(plan([dmg(MINE, "hero-p2", amount, true)], 300)).map(round6);
    expect(trauma(3)).toEqual([0.5625]);
    expect(trauma(4)).toEqual([0.75]);
    expect(trauma(20)).toEqual([1]);
    expect(shakesOf(plan([dmg(MINE, "hero-p1", 4, true)], 300)).map(round6)).toEqual([0.75]);
  });

  it("B11 zero damage plans no splat and no shake", () => {
    const cues = plan([dmg(MINE, ENEMY, 0, true)], 300);
    expect(cues.some((c) => c.kind === "splat")).toBe(false);
    expect(shakesOf(cues)).toEqual([]);
    expectCues(cues, [burst("spark", cardT(ENEMY), "point", 0)]);
  });
});

describe("B12 poison", () => {
  it("B12 the fixture's second unit is Poisonous and the first is not", () => {
    const [first, second] = VIEW.you.units;
    expect(second?.keywords.some((k) => k.kind === "Poisonous")).toBe(true);
    expect(first?.keywords.some((k) => k.kind === "Poisonous")).toBe(false);
  });

  it("B12 a Poisonous source flies a poison projectile and adds a poison burst at the target", () => {
    forDs("damage", (D) => {
      const flight = r(FX_PROJECTILE_FLIGHT_FRACTION * D);
      expectCues(plan([dmg(POISONER, ENEMY, 3, false)], D), [
        projectile("poison", cardT(POISONER), cardT(ENEMY), flight),
        burst("spark", cardT(ENEMY), "point", flight),
        splat("damage", 3, cardT(ENEMY), flight, D),
        burst("poison", cardT(ENEMY), "area", flight),
        shake(0.45, flight),
      ]);
    });
  });

  it("B12 a Poisonous source in combat adds the poison burst at 0 and flies nothing", () => {
    expectCues(plan([dmg(POISONER, ENEMY, 7, true)], 300), [
      burst("spark", cardT(ENEMY), "point", 0),
      splat("damage", 7, cardT(ENEMY), 0, 300),
      burst("poison", cardT(ENEMY), "area", 0),
      shake(0.8, 0),
    ]);
  });

  it("B12 a source without Poisonous adds no poison burst and flies arcane", () => {
    const cues = plan([dmg(MINE, ENEMY, 3, false)], 300);
    expect(cues.some((c) => "preset" in c && c.preset === "poison")).toBe(false);
    expect(cues.find((c) => c.kind === "projectile")).toMatchObject({ preset: "arcane" });
  });

  it("B12 Poisonous is read from the planning view: the same unit without it plans no poison", () => {
    const view = fullBoardView();
    const second = must(view.you.units[1], "the second unit");
    view.you.units[1] = { ...second, keywords: second.keywords.filter((k) => k.kind !== "Poisonous") };
    const cues = plan([dmg(POISONER, ENEMY, 3, false)], 300, { view });
    expect(cues.some((c) => "preset" in c && c.preset === "poison")).toBe(false);
  });
});

/* ------------------------------------------------------------------------------------------- *
 * B13: sources and memory
 * ------------------------------------------------------------------------------------------- */

describe("B13 sourceAnchor and memory", () => {
  it("B13 a rendered instance comes first: a unit, a face-up backrow card or a card in the viewer's hand", () => {
    const memory = createFxMemory();
    expect(sourceAnchor(MINE, VIEW, memory)).toEqual({ anchor: cardT(MINE), kind: "unit" });
    expect(sourceAnchor(ENEMY, VIEW, memory)).toEqual({ anchor: cardT(ENEMY), kind: "unit" });
    expect(sourceAnchor(FIELD_SPELL, VIEW, memory)).toEqual({ anchor: cardT(FIELD_SPELL), kind: "backrow" });
    expect(sourceAnchor(HAND, VIEW, memory)).toEqual({ anchor: handCardT(HAND), kind: "hand" });
  });

  it("B13 then the zone of a trap remembered from an earlier trapFired", () => {
    const memory = createFxMemory();
    memory.remember([{ type: "trapFired", instanceId: "t77", defId: "core-084", controller: "p1", row: "backrow", lane: 3 }]);
    expect(sourceAnchor("t77", VIEW, memory)).toEqual({ anchor: zoneT("you", "backrow", 3), kind: "trap" });
    memory.remember([{ type: "trapFired", instanceId: "t78", defId: "core-085", controller: "p2", row: "backrow", lane: 4 }]);
    expect(sourceAnchor("t78", VIEW, memory)).toEqual({ anchor: zoneT("opponent", "backrow", 4), kind: "trap" });
  });

  it("B13 then the hero of the player remembered from its cardPlayed", () => {
    const memory = createFxMemory();
    memory.remember([played("p2", "s42", "core-070"), played("p1", "s43", "core-071")]);
    expect(sourceAnchor("s42", VIEW, memory)).toEqual({ anchor: heroT("opponent"), kind: "hero" });
    expect(sourceAnchor("s43", VIEW, memory)).toEqual({ anchor: heroT("you"), kind: "hero" });
  });

  it("B13 then nothing: a null or unknown source has no anchor", () => {
    const memory = createFxMemory();
    expect(sourceAnchor(null, VIEW, memory)).toBeNull();
    expect(sourceAnchor("nowhere", VIEW, memory)).toBeNull();
    expect(sourceAnchor(MINE, baseView(), memory)).toBeNull();
  });

  it("B13 a rendered instance beats a remembered trap, and a remembered trap beats a remembered caster", () => {
    const memory = createFxMemory();
    memory.remember([
      { type: "trapFired", instanceId: MY_TRAP, defId: "core-084", controller: "p1", row: "backrow", lane: 5 },
      played("p2", "x1", "core-070"),
      { type: "trapFired", instanceId: "x1", defId: "core-071", controller: "p2", row: "backrow", lane: 2 },
    ]);
    expect(sourceAnchor(MY_TRAP, VIEW, memory)).toEqual({ anchor: cardT(MY_TRAP), kind: "backrow" });
    expect(sourceAnchor("x1", VIEW, memory)).toEqual({ anchor: zoneT("opponent", "backrow", 2), kind: "trap" });
  });

  it("B13 planFx flies arcane from a remembered trap zone and fire from a remembered caster's hero", () => {
    const flight = r(FX_PROJECTILE_FLIGHT_FRACTION * 300);
    expectCues(
      plan([dmg("t77", "hero-p2", 5, false)], 300, {
        prime: [{ type: "trapFired", instanceId: "t77", defId: "core-084", controller: "p1", row: "backrow", lane: 3 }],
      }),
      [
        projectile("arcane", zoneT("you", "backrow", 3), heroT("opponent"), flight),
        burst("spark", heroT("opponent"), "point", flight),
        splat("damage", 5, heroT("opponent"), flight, 300),
        shake(0.75 * 1.25, flight),
      ],
    );
    expectCues(plan([dmg("s42", ENEMY_2, 4, false)], 300, { prime: [played("p2", "s42", "core-070")] }), [
      projectile("fire", heroT("opponent"), cardT(ENEMY_2), flight),
      burst("spark", cardT(ENEMY_2), "point", flight),
      splat("damage", 4, cardT(ENEMY_2), flight, 300),
      shake(0.6, flight),
    ]);
  });

  it("B13 without memory the same spell damage flies nothing", () => {
    const cues = plan([dmg("s42", ENEMY_2, 4, false)], 300);
    expect(cues.some((c) => c.kind === "projectile")).toBe(false);
  });

  it("B13 memory records the caster of each cardPlayed and the zone of each trapFired, and nothing else", () => {
    const memory = createFxMemory();
    memory.remember([
      played("p1", "a1"),
      { type: "trapFired", instanceId: "t1", defId: "core-084", controller: "p2", row: "backrow", lane: 4 },
      { type: "drawn", player: "p1", instanceId: "d1", defId: "core-055" },
      summon("p2", "s1", "core-040", "units", 1),
    ]);
    expect(memory.casterOf("a1")).toBe("p1");
    expect(memory.trapZoneOf("t1")).toEqual({ player: "p2", row: "backrow", lane: 4 });
    expect(memory.casterOf("t1")).toBeUndefined();
    expect(memory.trapZoneOf("a1")).toBeUndefined();
    expect(memory.casterOf("d1")).toBeUndefined();
    expect(memory.casterOf("s1")).toBeUndefined();
  });

  it("B13 memory.clear forgets every caster and trap", () => {
    const memory = createFxMemory();
    memory.remember([played("p1", "a1"), { type: "trapFired", instanceId: "t1", defId: "core-084", controller: "p2", row: "backrow", lane: 4 }]);
    memory.clear();
    expect(memory.casterOf("a1")).toBeUndefined();
    expect(memory.trapZoneOf("t1")).toBeUndefined();
    expect(sourceAnchor("a1", VIEW, memory)).toBeNull();
  });

  it("B13 memory evicts the oldest entry of a map once it holds its limit", () => {
    const memory = createFxMemory(2);
    memory.remember([played("p1", "a1")]);
    memory.remember([played("p2", "a2"), played("p1", "a3")]);
    expect(memory.casterOf("a1")).toBeUndefined();
    expect(memory.casterOf("a2")).toBe("p2");
    expect(memory.casterOf("a3")).toBe("p1");

    const traps = createFxMemory(2);
    for (const [id, lane] of [["t1", 1], ["t2", 2], ["t3", 3]] as const) {
      traps.remember([{ type: "trapFired", instanceId: id, defId: "core-084", controller: "p1", row: "backrow", lane }]);
    }
    expect(traps.trapZoneOf("t1")).toBeUndefined();
    expect(traps.trapZoneOf("t3")).toEqual({ player: "p1", row: "backrow", lane: 3 });
  });

  it("B13 the default memory keeps FX_MEMORY_LIMIT casters", () => {
    expect(FX_MEMORY_LIMIT).toBe(64);
    const memory = createFxMemory();
    for (let i = 0; i <= FX_MEMORY_LIMIT; i += 1) memory.remember([played("p1", `k${i}`)]);
    expect(memory.casterOf("k0")).toBeUndefined();
    expect(memory.casterOf("k1")).toBe("p1");
    expect(memory.casterOf(`k${FX_MEMORY_LIMIT}`)).toBe("p1");
  });
});

/* ------------------------------------------------------------------------------------------- *
 * B14, B15: summon and cast
 * ------------------------------------------------------------------------------------------- */

describe("B14 summon", () => {
  const ZONE = testid.zone("you", "units", 3);

  function summonCues(facts: FxCardFacts | undefined, D: number, row: "units" | "backrow" = "units"): FxCue[] {
    const zoneLane = 3;
    return plan([summon("p1", "n1", "core-500", row, zoneLane)], D, {
      env: envOf({ card: (defId) => (defId === "core-500" ? facts : undefined) }),
    });
  }

  it("B14 a Common unit plans a dust ring and a dust burst at the zone's foot at the slam, and no shake under 10 stats", () => {
    forDs("summoned", (D) => {
      const slam = r(FX_SLAM_AT * D);
      expectCues(summonCues({ rarity: "Common", attack: 2, health: 3 }, D), [
        ring("dust", tid(ZONE), slam, D),
        burst("dust", tid(ZONE, FOOT), "ring", slam),
      ]);
    });
  });

  it("B14 a Legendary adds legendary rays from 0, a gold burst at the slam and FX_LEGENDARY_TRAUMA", () => {
    forDs("summoned", (D) => {
      const slam = r(FX_SLAM_AT * D);
      expectCues(summonCues({ rarity: "Legendary", attack: 1, health: 1 }, D), [
        ring("dust", tid(ZONE), slam, D),
        burst("dust", tid(ZONE, FOOT), "ring", slam),
        rays("legendary", tid(ZONE), 0, D),
        burst("gold", tid(ZONE), "area", slam),
        shake(0.5, slam),
      ]);
    });
  });

  it("B14 a Mythic adds mythic rays, a prismatic burst and FX_LEGENDARY_TRAUMA", () => {
    forDs("summoned", (D) => {
      const slam = r(FX_SLAM_AT * D);
      expectCues(summonCues({ rarity: "Mythic", attack: 2, health: 2 }, D), [
        ring("dust", tid(ZONE), slam, D),
        burst("dust", tid(ZONE, FOOT), "ring", slam),
        rays("mythic", tid(ZONE), 0, D),
        burst("prismatic", tid(ZONE), "area", slam),
        shake(0.5, slam),
      ]);
    });
  });

  it("B14 slam trauma starts at 10 printed stats, grows 0.06 per stat and caps at 0.5", () => {
    const trauma = (attack: number, health: number) =>
      shakesOf(summonCues({ rarity: "Epic", attack, health }, 250)).map(round6);
    expect(trauma(4, 5)).toEqual([]);
    expect(trauma(5, 5)).toEqual([0.06]);
    expect(trauma(6, 6)).toEqual([0.18]);
    expect(trauma(10, 10)).toEqual([0.5]);
    expect(trauma(20, 20)).toEqual([0.5]);
  });

  it("B14 Legendary and Mythic trauma stacks on the slam trauma", () => {
    const slam = r(FX_SLAM_AT * 250);
    expect(shakesOf(summonCues({ rarity: "Legendary", attack: 5, health: 5 }, 250)).map(round6)).toEqual([0.56]);
    expect(shakesOf(summonCues({ rarity: "Mythic", attack: 6, health: 6 }, 250)).map(round6)).toEqual([0.68]);
    // A big Mythic slams as hard as a shake goes.
    expect(shakesOf(summonCues({ rarity: "Mythic", attack: 20, health: 20 }, 250)).map(round6)).toEqual([1]);
    expect(summonCues({ rarity: "Mythic", attack: 20, health: 20 }, 250).find((c) => c.kind === "shake")?.delayMs).toBe(slam);
  });

  it("B14 missing attack and health count as 0", () => {
    forDs("summoned", (D) => {
      const slam = r(FX_SLAM_AT * D);
      expectCues(summonCues({ rarity: "Epic" }, D), [ring("dust", tid(ZONE), slam, D), burst("dust", tid(ZONE, FOOT), "ring", slam)]);
      expectCues(summonCues({ attack: 30 }, D), [
        ring("dust", tid(ZONE), slam, D),
        burst("dust", tid(ZONE, FOOT), "ring", slam),
        shake(0.5, slam),
      ]);
    });
  });

  it("B14 a backrow set plans only the dust burst, even for a readable Legendary", () => {
    forDs("summoned", (D) => {
      const slam = r(FX_SLAM_AT * D);
      const zone = testid.zone("you", "backrow", 3);
      expectCues(summonCues({ rarity: "Legendary", attack: 9, health: 9 }, D, "backrow"), [burst("dust", tid(zone, FOOT), "ring", slam)]);
    });
  });

  it("B14 a def the catalog does not know plans only the dust burst", () => {
    forDs("summoned", (D) => {
      const slam = r(FX_SLAM_AT * D);
      expectCues(summonCues(undefined, D), [burst("dust", tid(ZONE, FOOT), "ring", slam)]);
    });
  });

  it("B14 Common, Rare, Epic and Token rarities get no rays and no rarity burst", () => {
    for (const rarity of ["Common", "Rare", "Epic", "Token"] as const) {
      const cues = summonCues({ rarity, attack: 1, health: 1 }, 250);
      expect(cues.some((c) => c.kind === "rays"), rarity).toBe(false);
      expect(cues.some((c) => c.kind === "burst" && (c.preset === "gold" || c.preset === "prismatic")), rarity).toBe(false);
      expect(shakesOf(cues), rarity).toEqual([]);
    }
  });

  it("B14 the opponent's summon lands on the opponent's zone", () => {
    const slam = r(FX_SLAM_AT * 250);
    const zone = testid.zone("opponent", "units", 2);
    expectCues(plan([summon("p2", "n2", "core-002", "units", 2)], 250, { env: envOf({ card: catalog(FACTS) }) }), [
      ring("dust", tid(zone), slam, 250),
      burst("dust", tid(zone, FOOT), "ring", slam),
    ]);
  });
});

describe("B15 cast", () => {
  it("B15 a cardPlayed paired with its own summoned plans only the summon", () => {
    for (const D of [ANIMATIONS.cardPlayed.durationMs, ODD_D]) {
      const slam = r(FX_SLAM_AT * D);
      const zone = testid.zone("you", "units", 3);
      const cues = plan([played("p1", HAND), summon("p1", HAND, "core-002", "units", 3)], D, {
        env: envOf({ card: catalog(FACTS) }),
      });
      expectCues(cues, [ring("dust", tid(zone), slam, D), burst("dust", tid(zone, FOOT), "ring", slam)]);
    }
  });

  it("B15 the viewer's unpaired cardPlayed plans an arcane area burst and an arcane ring at the played card", () => {
    forDs("cardPlayed", (D) => {
      expectCues(plan([played("p1", HAND)], D), [burst("arcane", handCardT(HAND), "area", 0), ring("arcane", handCardT(HAND), 0, D)]);
    });
  });

  it("B15 the viewer's cardPlayed of a card the view no longer holds still marks its hand-card testid", () => {
    const ghostCard = "c999";
    expectCues(plan([played("p1", ghostCard)], 400), [
      burst("arcane", handCardT(ghostCard), "area", 0),
      ring("arcane", handCardT(ghostCard), 0, 400),
    ]);
  });

  it("B15 the opponent's cardPlayed plans one arcane point burst at hand-opponent and no ring", () => {
    forDs("cardPlayed", (D) => {
      expectCues(plan([played("p2", "hidden", "hidden")], D), [burst("arcane", tid("hand-opponent"), "point", 0)]);
      expectCues(plan([played("p2", "sp9", "core-070")], D), [burst("arcane", tid("hand-opponent"), "point", 0)]);
    });
  });
});

/* ------------------------------------------------------------------------------------------- *
 * B16: one test per S7 row
 * ------------------------------------------------------------------------------------------- */

describe("B16 the recipe table, row by row", () => {
  it("B16 healed: holy rays and a holy burst at 0, a heal splat at 0.2 D", () => {
    forDs("healed", (D) => {
      const at = r(FX_HEAL_SPLAT_AT * D);
      expectCues(plan([{ type: "healed", targetId: "hero-p1", amount: 4 }], D), [
        rays("holy", heroT("you"), 0, D),
        burst("holy", heroT("you"), "area", 0),
        splat("heal", 4, heroT("you"), at, D),
      ]);
      expectCues(plan([{ type: "healed", targetId: MINE_3, amount: 2 }], D), [
        rays("holy", cardT(MINE_3), 0, D),
        burst("holy", cardT(MINE_3), "area", 0),
        splat("heal", 2, cardT(MINE_3), at, D),
      ]);
    });
  });

  it("B16 healed on a target the view does not render plans nothing", () => {
    expect(plan([{ type: "healed", targetId: "nowhere", amount: 4 }], 300)).toEqual([]);
  });

  it("B16 healthLost: a void burst and a loss splat at the hero, both at 0", () => {
    forDs("healthLost", (D) => {
      expectCues(plan([{ type: "healthLost", player: "p2", amount: 3 }], D), [
        burst("void", heroT("opponent"), "area", 0),
        splat("loss", 3, heroT("opponent"), 0, D),
      ]);
      expectCues(plan([{ type: "healthLost", player: "p1", amount: 5 }], D), [
        burst("void", heroT("you"), "area", 0),
        splat("loss", 5, heroT("you"), 0, D),
      ]);
    });
  });

  it("B16 divineShieldLost: a gold ring and a shard ring burst at the card", () => {
    forDs("divineShieldLost", (D) => {
      expectCues(plan([{ type: "divineShieldLost", instanceId: ENEMY }], D), [
        ring("gold", cardT(ENEMY), 0, D),
        burst("shard", cardT(ENEMY), "ring", 0),
      ]);
    });
  });

  it("B16 divineShieldLost on a card the view does not render plans nothing", () => {
    expect(plan([{ type: "divineShieldLost", instanceId: "nowhere" }], 250)).toEqual([]);
  });

  it("B16 destroyed on the board: a crack at 0, embers at 0.3 D and smoke at 0.5 D", () => {
    forDs("destroyed", (D) => {
      expectCues(
        plan([{ type: "destroyed", instanceId: MINE_3, defId: "core-017", owner: "p1", attack: 1, maxHealth: 6, killerId: ENEMY }], D),
        [
          crack(cardT(MINE_3), 0, D),
          burst("ember", cardT(MINE_3), "area", r(FX_DEATH_EMBER_AT * D)),
          burst("smoke", cardT(MINE_3), "area", r(FX_DEATH_SMOKE_AT * D)),
        ],
      );
    });
  });

  it("B16 destroyed off the board: one smoke puff at the graveyard pile and no crack", () => {
    forDs("destroyed", (D) => {
      expectCues(
        plan([{ type: "destroyed", instanceId: "gone", defId: "core-017", owner: "p2", attack: 1, maxHealth: 1, killerId: null }], D),
        [burst("smoke", tid("graveyard-opponent"), "point", 0)],
      );
    });
  });

  it("B16 exiled: a void ring and a void burst, at the card or at the exile pile", () => {
    forDs("exiled", (D) => {
      expectCues(plan([{ type: "exiled", instanceId: ENEMY_2, defId: "core-013", owner: "p2" }], D), [
        ring("void", cardT(ENEMY_2), 0, D),
        burst("void", cardT(ENEMY_2), "area", 0),
      ]);
      expectCues(plan([{ type: "exiled", instanceId: "gone", defId: "core-013", owner: "p1" }], D), [
        ring("void", tid("exile-you"), 0, D),
        burst("void", tid("exile-you"), "area", 0),
      ]);
    });
  });

  it("B16 burned: fire and embers over the owner's hand at 0.25 D", () => {
    forDs("burned", (D) => {
      const at = r(FX_BURN_AT * D);
      expectCues(plan([{ type: "burned", instanceId: "hidden", defId: "hidden", owner: "p2" }], D), [
        burst("fire", tid("hand-opponent"), "area", at),
        burst("ember", tid("hand-opponent"), "area", at),
      ]);
      expectCues(plan([{ type: "burned", instanceId: "cX", defId: "core-041", owner: "p1" }], D), [
        burst("fire", tid("hand-you"), "area", at),
        burst("ember", tid("hand-you"), "area", at),
      ]);
    });
  });

  it("B16 radiantSet on a board card: a sheen, radiant rays and a gold burst at 0.4 D", () => {
    forDs("radiantSet", (D) => {
      expectCues(
        plan([{ type: "radiantSet", instanceId: POISONER, defId: "core-011", zone: { z: "field", player: "p1", row: "units", lane: 2 } }], D),
        [sheen(cardT(POISONER), D), burst("gold", cardT(POISONER), "area", r(FX_RADIANT_BURST_AT * D)), rays("radiant", cardT(POISONER), 0, D)],
      );
    });
  });

  it("B16 radiantSet off the board gets the sheen and burst but no rays", () => {
    forDs("radiantSet", (D) => {
      const at = r(FX_RADIANT_BURST_AT * D);
      expectCues(plan([{ type: "radiantSet", instanceId: HAND_2, defId: "core-019", zone: { z: "hand", player: "p1" } }], D), [
        sheen(handCardT(HAND_2), D),
        burst("gold", handCardT(HAND_2), "area", at),
      ]);
      expectCues(plan([{ type: "radiantSet", instanceId: "hidden", defId: "hidden", zone: { z: "hand", player: "p2" } }], D), [
        sheen(tid("hand-opponent"), D),
        burst("gold", tid("hand-opponent"), "area", at),
      ]);
      expectCues(plan([{ type: "radiantSet", instanceId: "gone", defId: "core-003", zone: { z: "graveyard", player: "p1" } }], D), [
        sheen(tid("graveyard-you"), D),
        burst("gold", tid("graveyard-you"), "area", at),
      ]);
    });
  });

  it("B16 transformed: a smoke point burst and an arcane point burst at the card", () => {
    forDs("transformed", (D) => {
      expectCues(
        plan([{ type: "transformed", instanceId: MINE_3, fromDefId: "core-017", toDefId: "token-sheep", newInstanceId: "c90" }], D),
        // Centred on the unit (integration QA: an area of puffs drifted over the next lanes).
        [burst("smoke", cardT(MINE_3), "point", 0), burst("arcane", cardT(MINE_3), "point", 0)],
      );
    });
  });

  it("B16 transformed with neither instance rendered plans nothing", () => {
    expect(
      plan([{ type: "transformed", instanceId: "gone", fromDefId: "core-017", toDefId: "token-sheep", newInstanceId: "also-gone" }], 400),
    ).toEqual([]);
  });

  it("B16 fused: smoke at every located ingredient, arcane projectiles into the survivor and an arcane burst on arrival", () => {
    forDs("fused", (D) => {
      const f = r(FX_FUSE_FLIGHT_FRACTION * D);
      expectCues(plan([{ type: "fused", instanceIds: [MINE, POISONER], resultInstanceId: "c91", defId: "core-088" }], D), [
        burst("smoke", cardT(MINE), "area", 0),
        burst("smoke", cardT(POISONER), "area", 0),
        projectile("arcane", cardT(POISONER), cardT(MINE), f),
        burst("arcane", cardT(MINE), "area", f),
      ]);
    });
  });

  it("B16 fused skips ingredients the view does not render", () => {
    forDs("fused", (D) => {
      const f = r(FX_FUSE_FLIGHT_FRACTION * D);
      expectCues(plan([{ type: "fused", instanceIds: ["gone", POISONER, MINE_3], resultInstanceId: "c91", defId: "core-088" }], D), [
        burst("smoke", cardT(POISONER), "area", 0),
        burst("smoke", cardT(MINE_3), "area", 0),
        projectile("arcane", cardT(MINE_3), cardT(POISONER), f),
        burst("arcane", cardT(POISONER), "area", f),
      ]);
      expectCues(plan([{ type: "fused", instanceIds: [MINE, "gone"], resultInstanceId: "c91", defId: "core-088" }], D), [
        burst("smoke", cardT(MINE), "area", 0),
        burst("arcane", cardT(MINE), "area", f),
      ]);
    });
  });

  it("B16 trapFired: an arcane ring, an arcane ring burst and a punch shake at 0.2 D, on the card the viewer reads", () => {
    forDs("trapFired", (D) => {
      const b = r(FX_TRAP_BURST_AT * D);
      expectCues(plan([{ type: "trapFired", instanceId: MY_TRAP, defId: "core-084", controller: "p1", row: "backrow", lane: 5 }], D), [
        ring("arcane", cardT(MY_TRAP), 0, D),
        burst("arcane", cardT(MY_TRAP), "ring", b),
        shake(0.4, b),
      ]);
    });
  });

  it("B16 trapFired the viewer may not read plays on its zone", () => {
    forDs("trapFired", (D) => {
      const b = r(FX_TRAP_BURST_AT * D);
      const zone = zoneT("opponent", "backrow", 4);
      expectCues(plan([{ type: "trapFired", instanceId: "hidden", defId: "hidden", controller: "p2", row: "backrow", lane: 4 }], D), [
        ring("arcane", zone, 0, D),
        burst("arcane", zone, "ring", b),
        shake(0.4, b),
      ]);
    });
  });

  it("B16 locked: a dust ring and a dust burst at the zone", () => {
    forDs("locked", (D) => {
      expectCues(plan([{ type: "locked", player: "p2", row: "units", lane: 2 }], D), [
        ring("dust", zoneT("opponent", "units", 2), 0, D),
        burst("dust", zoneT("opponent", "units", 2), "area", 0),
      ]);
    });
  });

  it("B16 attackDeclared: a dust kick at the attacker's foot", () => {
    forDs("attackDeclared", (D) => {
      expectCues(plan([{ type: "attackDeclared", attackerId: MINE, targetId: ENEMY, forced: false }], D), [
        burst("dust", tid(testid.card(MINE), FOOT), "point", 0),
      ]);
    });
  });

  it("B16 attackDeclared by an attacker the view does not render plans nothing", () => {
    expect(plan([{ type: "attackDeclared", attackerId: "nowhere", targetId: ENEMY, forced: true }], 350)).toEqual([]);
  });

  it("B16 attackCancelled: a smoke puff at the attacker", () => {
    forDs("attackCancelled", (D) => {
      expectCues(plan([{ type: "attackCancelled", attackerId: MINE, targetId: ENEMY, byInstanceId: "b5" }], D), [
        burst("smoke", cardT(MINE), "point", 0),
      ]);
    });
  });

  it("B16 keywordGranted: Divine Shield rings gold, Poisonous clouds, Taunt rings dust, anything else sparks arcane", () => {
    forDs("keywordGranted", (D) => {
      const grant = (keyword: Extract<GameEvent, { type: "keywordGranted" }>["keyword"]) =>
        plan([{ type: "keywordGranted", instanceId: MINE_3, keyword }], D);
      expectCues(grant({ kind: "Divine Shield" }), [ring("gold", cardT(MINE_3), 0, D), burst("holy", cardT(MINE_3), "ring", 0)]);
      expectCues(grant({ kind: "Poisonous" }), [burst("poison", cardT(MINE_3), "area", 0)]);
      expectCues(grant({ kind: "Taunt" }), [ring("dust", cardT(MINE_3), 0, D)]);
      for (const keyword of [{ kind: "Rush" }, { kind: "Charge" }, { kind: "Armor", n: 2 }, { kind: "Lucky", n: 3 }] as const) {
        expectCues(grant(keyword), [burst("arcane", cardT(MINE_3), "point", 0)]);
      }
    });
  });

  it("B16 keywordGranted and counterChanged on a card the view does not render plan nothing", () => {
    expect(plan([{ type: "keywordGranted", instanceId: "nowhere", keyword: { kind: "Divine Shield" } }], 200)).toEqual([]);
    expect(plan([{ type: "keywordGranted", instanceId: "nowhere", keyword: { kind: "Rush" } }], 200)).toEqual([]);
    expect(plan([{ type: "counterChanged", instanceId: "nowhere", counter: "plague", value: 1 }], 200)).toEqual([]);
    expect(plan([{ type: "counterChanged", instanceId: "nowhere", counter: "grade", value: 1 }], 200)).toEqual([]);
  });

  it("B16 counterChanged: plague clouds poison, grade sparkles", () => {
    forDs("counterChanged", (D) => {
      expectCues(plan([{ type: "counterChanged", instanceId: ENEMY, counter: "plague", value: 2 }], D), [
        burst("poison", cardT(ENEMY), "area", 0),
      ]);
      expectCues(plan([{ type: "counterChanged", instanceId: MINE_3, counter: "grade", value: 1 }], D), [
        burst("sparkle", cardT(MINE_3), "point", 0),
      ]);
    });
  });

  it("B16 costChanged: an arcane glint at the card, and nothing when it is not rendered", () => {
    expectCues(plan([{ type: "costChanged", instanceId: HAND, cost: 0 }], 200), [burst("arcane", handCardT(HAND), "point", 0)]);
    expectCues(plan([{ type: "costChanged", instanceId: ENEMY, cost: 1 }], 200), [burst("arcane", cardT(ENEMY), "point", 0)]);
    expect(plan([{ type: "costChanged", instanceId: "nowhere", cost: 1 }], 200)).toEqual([]);
  });

  it("B16 modifierChanged: an arcane glint when added", () => {
    expectCues(plan([{ type: "modifierChanged", player: "p2", modifierId: "m9", added: true }], 200), [
      burst("arcane", tid("modifiers-opponent"), "point", 0),
    ]);
    expectCues(plan([{ type: "modifierChanged", player: "p1", modifierId: "m9", added: true }], 200), [
      burst("arcane", tid("modifiers-you"), "point", 0),
    ]);
  });

  it("B16 modifierChanged plans nothing when a modifier is removed", () => {
    expect(plan([{ type: "modifierChanged", player: "p2", modifierId: "m3", added: false }], 200)).toEqual([]);
  });

  it("B16 addedToHand: a sparkle burst over the player's hand", () => {
    forDs("addedToHand", (D) => {
      expectCues(plan([{ type: "addedToHand", player: "p2", instanceId: "hidden", defId: "hidden" }], D), [
        burst("sparkle", tid("hand-opponent"), "area", 0),
      ]);
      expectCues(plan([{ type: "addedToHand", player: "p1", instanceId: "cZ", defId: "core-060" }], D), [
        burst("sparkle", tid("hand-you"), "area", 0),
      ]);
    });
  });

  it("B16 controlChanged: arcane motes fly from the card's old place to its new zone over 0.7 D", () => {
    forDs("controlChanged", (D) => {
      const f = r(FX_MIND_CONTROL_FLIGHT_FRACTION * D);
      const zone = zoneT("you", "units", 4);
      expectCues(plan([{ type: "controlChanged", instanceId: ENEMY, controller: "p1", row: "units", lane: 4 }], D), [
        projectile("arcane", cardT(ENEMY), zone, f),
        burst("arcane", zone, "area", f),
      ]);
    });
  });

  it("B16 controlChanged of a card the view does not render bursts at the new zone at 0", () => {
    forDs("controlChanged", (D) => {
      const zone = zoneT("opponent", "units", 1);
      expectCues(plan([{ type: "controlChanged", instanceId: "gone", controller: "p2", row: "units", lane: 1 }], D), [
        burst("arcane", zone, "area", 0),
      ]);
    });
  });

  it("B16 the 11 rows without an fx recipe plan nothing", () => {
    const bare: GameEvent[] = [
      { type: "cardResolved", player: "p1", instanceId: HAND, defId: "core-002", permanent: false, costPaid: 1 },
      { type: "enteredGraveyard", instanceId: MINE, defId: "core-004", owner: "p1" },
      { type: "positionSwitched", instanceId: MINE_3, position: "ATK" },
      { type: "rotated", direction: "right" },
      { type: "swapped", what: "board" },
      { type: "turnEnded", player: "p1", turn: 3, unspentMana: 1 },
      { type: "promptOpened", player: "p1", choiceId: "ch1", kind: "target" },
      { type: "promptAnswered", player: "p1", choiceId: "ch1" },
      { type: "drawOffered", player: "p2" },
      { type: "drawAnswered", player: "p1", accept: true },
      { type: "gameOver", winner: "p2", reason: "concede" },
    ];
    for (const event of bare) expect(plan([event], 300), event.type).toEqual([]);
  });
});

/* ------------------------------------------------------------------------------------------- *
 * B17, B18: flights and buffs
 * ------------------------------------------------------------------------------------------- */

describe("B17 card flights", () => {
  it("B17 drawn: a card back flies from library to hand over D, and a sparkle lands at D", () => {
    forDs("drawn", (D) => {
      expectCues(plan([{ type: "drawn", player: "p1", instanceId: "cY", defId: "core-055" }], D), [
        ghost(tid("library-you"), tid("hand-you"), D),
        burst("sparkle", tid("hand-you"), "point", D),
      ]);
      expectCues(plan([{ type: "drawn", player: "p2", instanceId: "hidden", defId: "hidden" }], D), [
        ghost(tid("library-opponent"), tid("hand-opponent"), D),
        burst("sparkle", tid("hand-opponent"), "point", D),
      ]);
    });
  });

  it("B17 bounced: smoke at the card and a card back flying to the owner's hand", () => {
    forDs("bounced", (D) => {
      expectCues(plan([{ type: "bounced", instanceId: MINE_3, defId: "core-017", owner: "p1" }], D), [
        burst("smoke", cardT(MINE_3), "area", 0),
        ghost(cardT(MINE_3), tid("hand-you"), D),
      ]);
      expectCues(plan([{ type: "bounced", instanceId: ENEMY_2, defId: "core-013", owner: "p2" }], D), [
        burst("smoke", cardT(ENEMY_2), "area", 0),
        ghost(cardT(ENEMY_2), tid("hand-opponent"), D),
      ]);
    });
  });

  it("B17 bounced off the board: smoke at the hand region and no ghost", () => {
    forDs("bounced", (D) => {
      const cues = plan([{ type: "bounced", instanceId: "gone", defId: "core-013", owner: "p2" }], D);
      expect(cues.some((c) => c.kind === "ghost")).toBe(false);
      expectCues(cues, [burst("smoke", tid("hand-opponent"), "area", 0)]);
    });
  });

  it("B17 discarded: a card back flies from the hand card to the owner's graveyard, with embers at D", () => {
    forDs("discarded", (D) => {
      expectCues(plan([{ type: "discarded", instanceId: HAND, defId: "core-002", owner: "p1" }], D), [
        ghost(handCardT(HAND), tid("graveyard-you"), D),
        burst("ember", tid("graveyard-you"), "point", D),
      ]);
      expectCues(plan([{ type: "discarded", instanceId: "hidden", defId: "hidden", owner: "p2" }], D), [
        ghost(tid("hand-opponent"), tid("graveyard-opponent"), D),
        burst("ember", tid("graveyard-opponent"), "point", D),
      ]);
    });
  });

  it("B17 shuffledIn: a card back flies from the viewport centre into the library, with an arcane burst at D", () => {
    forDs("shuffledIn", (D) => {
      expectCues(plan([{ type: "shuffledIn", player: "p1", instanceId: "cW", defId: "core-070", position: 3 }], D), [
        ghost(CENTER, tid("library-you"), D),
        burst("arcane", tid("library-you"), "point", D),
      ]);
      expectCues(plan([{ type: "shuffledIn", player: "p2", instanceId: "hidden", defId: "hidden", position: 0 }], D), [
        ghost(CENTER, tid("library-opponent"), D),
        burst("arcane", tid("library-opponent"), "point", D),
      ]);
    });
  });
});

describe("B18 buff arrows", () => {
  it("B18 a net-positive buff plans arrows up and sparkles", () => {
    forDs("buffed", (D) => {
      for (const [attack, health] of [[2, 1], [0, 1], [3, -1]] as const) {
        expectCues(plan([{ type: "buffed", instanceId: MINE_3, attack, health }], D), [
          arrows("up", cardT(MINE_3), D),
          burst("sparkle", cardT(MINE_3), "area", 0),
        ]);
      }
    });
  });

  it("B18 a net-negative buff plans arrows down and a void burst", () => {
    forDs("buffed", (D) => {
      for (const [attack, health] of [[-2, 0], [-1, -1], [1, -3]] as const) {
        expectCues(plan([{ type: "buffed", instanceId: ENEMY, attack, health }], D), [
          arrows("down", cardT(ENEMY), D),
          burst("void", cardT(ENEMY), "area", 0),
        ]);
      }
    });
  });

  it("B18 a buff that nets to zero plans nothing", () => {
    for (const [attack, health] of [[0, 0], [2, -2], [-3, 3]] as const) {
      expect(plan([{ type: "buffed", instanceId: MINE_3, attack, health }], 250)).toEqual([]);
    }
  });

  it("B18 a buff on a card the view does not render plans nothing", () => {
    expect(plan([{ type: "buffed", instanceId: "nowhere", attack: 2, health: 2 }], 250)).toEqual([]);
  });
});

/* ------------------------------------------------------------------------------------------- *
 * B19, B20: mana and banners
 * ------------------------------------------------------------------------------------------- */

describe("B19 mana sparks", () => {
  function manaCues(player: "p1" | "p2", current: number, D: number, view?: PlayerView): FxCue[] {
    return plan([{ type: "manaChanged", player, current, max: Math.max(current, 1) }], D, view === undefined ? {} : { view });
  }

  it("B19 one sparkle per crystal that fills, from the planning view's current mana up", () => {
    // The fixture's viewer has 2 of 4 crystals lit; the opponent has 0 of 3.
    expect(VIEW.you.mana.current).toBe(2);
    expect(VIEW.opponent.mana.current).toBe(0);
    const D = ANIMATIONS.manaChanged.durationMs;
    const step = Math.min(FX_MANA_STAGGER_MS, Math.floor(D / 2));
    expectCues(manaCues("p1", 4, D), [
      burst("sparkle", crystal("you", 2), "point", 0),
      burst("sparkle", crystal("you", 3), "point", step),
    ]);
    const step3 = Math.min(FX_MANA_STAGGER_MS, Math.floor(D / 3));
    expectCues(manaCues("p2", 3, D), [
      burst("sparkle", crystal("opponent", 0), "point", 0),
      burst("sparkle", crystal("opponent", 1), "point", step3),
      burst("sparkle", crystal("opponent", 2), "point", 2 * step3),
    ]);
  });

  it("B19 at most FX_MANA_MAX_SPARKS sparks, however far mana rises", () => {
    expect(FX_MANA_MAX_SPARKS).toBe(10);
    const cues = manaCues("p1", 30, 150);
    expect(cues).toHaveLength(FX_MANA_MAX_SPARKS);
    const indices = cues.map((c) => (c.kind === "burst" && c.at.kind === "crystal" ? c.at.index : -1));
    expect(indices).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("B19 delays increase and stay inside D, compressing when D is short", () => {
    for (const D of [MIN_ENTRY_MS, 150, 400, ODD_D]) {
      const cues = manaCues("p2", 10, D);
      const delays = cues.map((c) => c.delayMs);
      expect(delays, `D=${D}`).toHaveLength(10);
      const step = Math.min(FX_MANA_STAGGER_MS, Math.floor(D / 10));
      expect(delays, `D=${D}`).toEqual(delays.map((_, i) => Math.min(D, i * step)));
      for (let i = 1; i < delays.length; i += 1) expect(delays[i], `D=${D}`).toBeGreaterThan(delays[i - 1] ?? 0);
      for (const delay of delays) expect(delay).toBeLessThanOrEqual(D);
    }
  });

  it("B19 mana that does not rise plans nothing", () => {
    expect(manaCues("p1", 2, 150)).toEqual([]);
    expect(manaCues("p1", 1, 150)).toEqual([]);
    expect(manaCues("p1", 0, 150)).toEqual([]);
    expect(manaCues("p2", 0, 150)).toEqual([]);
  });

  it("B19 the old value comes from the planning view, not the event's max", () => {
    const view = fullBoardView();
    view.you = emptySide("p1", { mana: { current: 5, max: 7 } });
    expectCues(manaCues("p1", 6, 150, view), [burst("sparkle", crystal("you", 5), "point", 0)]);
    expect(manaCues("p1", 5, 150, view)).toEqual([]);
  });
});

describe("B20 turn banners", () => {
  it("B20 the viewer's turnStarted plans a gold Your turn banner and victory rays", () => {
    forDs("turnStarted", (D) => {
      expectCues(plan([{ type: "turnStarted", player: "p1", turn: 5 }], D), [
        banner("Your turn", "you", D + FX_BANNER_TAIL_MS),
        rays("victory", CENTER, 0, D),
      ]);
    });
  });

  it("B20 the opponent's turnStarted plans an Opponent's turn banner and no rays", () => {
    forDs("turnStarted", (D) => {
      const cues = plan([{ type: "turnStarted", player: "p2", turn: 6 }], D);
      expect(cues.some((c) => c.kind === "rays")).toBe(false);
      expectCues(cues, [banner("Opponent's turn", "opponent", D + FX_BANNER_TAIL_MS)]);
    });
  });

  it("B20 turnAutoEnded plans a muted No moves left banner for either player", () => {
    forDs("turnAutoEnded", (D) => {
      for (const player of ["p1", "p2"] as const) {
        expectCues(plan([{ type: "turnAutoEnded", player, turn: 5 }], D), [banner("No moves left", "muted", D + FX_BANNER_TAIL_MS)]);
      }
    });
  });

  it("B20 the banner follows the viewer: p2's turn is Your turn when p2 is viewing", () => {
    const view = baseView({ viewer: "p2", active: "p2", you: emptySide("p2"), opponent: emptySide("p1", { hand: { count: 3 } }) });
    expectCues(plan([{ type: "turnStarted", player: "p2", turn: 4 }], 600, { view }), [
      banner("Your turn", "you", 600 + FX_BANNER_TAIL_MS),
      rays("victory", CENTER, 0, 600),
    ]);
  });
});

/* ------------------------------------------------------------------------------------------- *
 * B21: R202, the redacted stream only
 * ------------------------------------------------------------------------------------------- */

const CUE_KEYS: Record<FxCue["kind"], readonly string[]> = {
  burst: ["kind", "preset", "at", "delayMs", "count", "spread", "power"],
  projectile: ["kind", "preset", "from", "to", "delayMs", "flightMs", "density"],
  crack: ["kind", "at", "delayMs", "durationMs"],
  ring: ["kind", "preset", "at", "delayMs", "durationMs"],
  shake: ["kind", "trauma", "delayMs"],
  splat: ["kind", "tone", "amount", "at", "delayMs", "durationMs"],
  rays: ["kind", "tone", "at", "delayMs", "durationMs"],
  sheen: ["kind", "at", "delayMs", "durationMs"],
  ghost: ["kind", "from", "to", "delayMs", "durationMs"],
  arrows: ["kind", "direction", "at", "delayMs", "durationMs"],
  banner: ["kind", "text", "tone", "delayMs", "durationMs"],
  result: ["kind", "outcome", "text", "delayMs", "durationMs"],
  hold: ["kind", "from", "to", "delayMs", "landMs", "durationMs"],
  conceal: ["kind", "testid", "mode", "delayMs", "durationMs"],
  lunge: ["kind", "attacker", "target", "delayMs", "durationMs"],
};

const ANCHOR_KEYS: Record<FxAnchor["kind"], { required: readonly string[]; optional: readonly string[] }> = {
  testid: { required: ["kind", "testid"], optional: ["at"] },
  crystal: { required: ["kind", "side", "index"], optional: [] },
  viewport: { required: ["kind", "at"], optional: [] },
};

function definedKeys(value: object): string[] {
  return Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .map(([k]) => k)
    .sort();
}

function checkAnchor(anchor: unknown, where: string): void {
  expect(anchor !== null && typeof anchor === "object", where).toBe(true);
  const kind = (anchor as { kind?: unknown }).kind as FxAnchor["kind"];
  const allowed = ANCHOR_KEYS[kind];
  expect(allowed, `${where}: unknown anchor kind ${String(kind)}`).toBeDefined();
  const keys = definedKeys(anchor as object);
  for (const key of allowed.required) expect(keys, where).toContain(key);
  for (const key of keys) expect([...allowed.required, ...allowed.optional], where).toContain(key);
}

function checkCue(cue: FxCue, where: string): void {
  const allowed = CUE_KEYS[cue.kind];
  expect(allowed, `${where}: unknown cue kind`).toBeDefined();
  expect(definedKeys(cue), where).toEqual([...allowed].sort());
  for (const field of ["at", "from", "to"] as const) {
    if (field in cue) checkAnchor((cue as Record<string, unknown>)[field], `${where}.${field}`);
  }
}

const HIDDEN_EVENTS: GameEvent[] = [
  { type: "cardPlayed", player: "p2", instanceId: "hidden", defId: "hidden", costPaid: 2 },
  { type: "summoned", player: "p2", instanceId: "hidden", defId: "hidden", row: "backrow", lane: 2 },
  { type: "summoned", player: "p2", instanceId: "hidden", defId: "hidden", row: "units", lane: 2 },
  { type: "drawn", player: "p2", instanceId: "hidden", defId: "hidden" },
  { type: "addedToHand", player: "p2", instanceId: "hidden", defId: "hidden" },
  { type: "discarded", instanceId: "hidden", defId: "hidden", owner: "p2" },
  { type: "burned", instanceId: "hidden", defId: "hidden", owner: "p2" },
  { type: "shuffledIn", player: "p2", instanceId: "hidden", defId: "hidden", position: 0 },
  { type: "radiantSet", instanceId: "hidden", defId: "hidden", zone: { z: "hand", player: "p2" } },
  { type: "trapFired", instanceId: "hidden", defId: "hidden", controller: "p2", row: "backrow", lane: 4 },
  { type: "damage", sourceId: "hidden", targetId: "hero-p1", amount: 4, combat: false },
];

describe("B21 the redacted stream only", () => {
  it("R202 a hidden def plans the same cues whatever the catalog would say, and never gets rarity rays", () => {
    const lookup = vi.fn((_defId: string): FxCardFacts | undefined => ({ rarity: "Legendary", attack: 9, health: 9 }));
    for (const D of [ANIMATIONS.summoned.durationMs, ODD_D]) {
      const slam = r(FX_SLAM_AT * D);
      const zone = testid.zone("opponent", "units", 2);
      const cues = plan([summon("p2", "hidden", "hidden", "units", 2)], D, { env: envOf({ card: lookup }) });
      expect(cues.some((c) => c.kind === "rays")).toBe(false);
      expectCues(cues, [burst("dust", tid(zone, FOOT), "ring", slam)]);
    }
    expect(lookup).not.toHaveBeenCalledWith("hidden");
  });

  it("B21 an event with hidden ids plans deep-equal cues whatever the catalog and memory hold", () => {
    const catalogs: FxPlanEnv["card"][] = [
      () => undefined,
      () => ({ rarity: "Legendary", attack: 9, health: 9 }),
      () => ({ rarity: "Mythic", attack: 1, health: 1 }),
    ];
    const primes: GameEvent[][] = [
      [],
      [played("p2", "hidden", "hidden"), { type: "trapFired", instanceId: "hidden", defId: "hidden", controller: "p2", row: "backrow", lane: 1 }],
      [played("p1", "s1", "core-070"), played("p2", "s2", "core-071")],
    ];
    for (const event of HIDDEN_EVENTS) {
      const D = ANIMATIONS[event.type].durationMs;
      const baseline = plan([event], D);
      expect(baseline.length, `${event.type} should plan something`).toBeGreaterThan(0);
      for (const card of catalogs) {
        for (const prime of primes) {
          expect(plan([event], D, { env: envOf({ card }), prime }), event.type).toEqual(baseline);
        }
      }
    }
  });

  it("B21 the planner never looks up a hidden defId", () => {
    const lookup = vi.fn((_defId: string): FxCardFacts | undefined => ({ rarity: "Mythic", attack: 5, health: 5 }));
    for (const event of HIDDEN_EVENTS) plan([event], ANIMATIONS[event.type].durationMs, { env: envOf({ card: lookup }) });
    expect(lookup).not.toHaveBeenCalledWith("hidden");
  });

  it("B21 memory ignores hidden ids, so a hidden source never flies a projectile", () => {
    const memory = createFxMemory();
    memory.remember([
      played("p2", "hidden", "hidden"),
      { type: "trapFired", instanceId: "hidden", defId: "hidden", controller: "p2", row: "backrow", lane: 3 },
    ]);
    expect(memory.casterOf("hidden")).toBeUndefined();
    expect(memory.trapZoneOf("hidden")).toBeUndefined();
    expect(sourceAnchor("hidden", VIEW, memory)).toBeNull();
    const cues = plan([dmg("hidden", "hero-p1", 4, false)], 300, { env: envOf({ memory }) });
    expect(cues.some((c) => c.kind === "projectile")).toBe(false);
  });

  it("B21 every cue has exactly the fields of its S1 type, and none names a card", () => {
    const cues: { cue: FxCue; where: string }[] = [];
    const defIds = new Set<string>();
    for (const sample of samples()) {
      for (const event of sample.events) {
        for (const key of ["defId", "fromDefId", "toDefId"] as const) {
          const value = (event as Record<string, unknown>)[key];
          if (typeof value === "string" && value !== "hidden") defIds.add(value);
        }
      }
      for (const cue of planSample(sample, 400)) cues.push({ cue, where: sample.name });
    }
    for (const winner of ["p1", "p2", "draw"] as const) {
      const view = fullBoardView({ result: { winner, reason: "hero-death" }, phase: "over" });
      for (const cue of planResult(view, { intensity: 1 })) cues.push({ cue, where: `result ${winner}` });
    }
    for (const cue of planHandover(baseView(), { intensity: 1 })) cues.push({ cue, where: "handover" });

    expect(cues.length).toBeGreaterThan(50);
    for (const { cue, where } of cues) {
      checkCue(cue, where);
      const text = JSON.stringify(cue);
      for (const defId of defIds) expect(text.includes(defId), `${where} leaks ${defId}: ${text}`).toBe(false);
    }
  });

  it("B21 planFx reads only its arguments: the DOM changes nothing, and its inputs are left untouched", () => {
    const events: GameEvent[] = [dmg(MINE, ENEMY, 5, false)];
    const bare = plan(events, 300);

    const target = document.createElement("div");
    target.setAttribute("data-testid", testid.card(ENEMY));
    document.body.appendChild(target);
    try {
      expect(plan(events, 300)).toEqual(bare);
    } finally {
      target.remove();
    }

    const view = withEvents(fullBoardView(), events);
    const entry = entryFor(events, view, 300);
    const env = envOf();
    env.memory.remember(entry.events);
    const viewBefore = JSON.stringify(view);
    const eventsBefore = JSON.stringify(entry.events);
    const first = planFx(entry, view, env);
    const second = planFx(entry, view, env);
    expect(second).toEqual(first);
    expect(first).toEqual(bare);
    expect(JSON.stringify(view)).toBe(viewBefore);
    expect(JSON.stringify(entry.events)).toBe(eventsBefore);
    expect(entry.durationMs).toBe(300);
  });

  it("B21 planFx works on frozen inputs", () => {
    function deepFreeze<V>(value: V): V {
      if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const inner of Object.values(value)) deepFreeze(inner);
      }
      return value;
    }
    for (const sample of samples()) {
      const { entry, view, env } = prepare(sample);
      const expected = planFx(entry, view, env);
      const frozenView = deepFreeze(JSON.parse(JSON.stringify(view)) as PlayerView);
      const frozenEvents = deepFreeze(JSON.parse(JSON.stringify(entry.events)) as GameEvent[]);
      const frozenEntry = deepFreeze({ ...entry, events: frozenEvents, view: frozenView });
      expect(() => planFx(frozenEntry, frozenView, env), sample.name).not.toThrow();
      expect(planFx(frozenEntry, frozenView, env), sample.name).toEqual(expected);
    }
  });
});

/* ------------------------------------------------------------------------------------------- *
 * B22: game over and hand-over
 * ------------------------------------------------------------------------------------------- */

describe("B22 planResult and planHandover", () => {
  const over = (winner: "p1" | "p2" | "draw", extra: Partial<PlayerView> = {}) =>
    fullBoardView({ result: { winner, reason: "hero-death" }, phase: "over", ...extra });

  it("B22 victory: the Victory overlay, rays, confetti, and the enemy hero cracking and bursting", () => {
    expectCues(planResult(over("p1"), { intensity: 1 }), [
      { kind: "result", outcome: "victory", text: "Victory", delayMs: 0, durationMs: FX_RESULT_MS },
      { kind: "rays", tone: "victory", at: CENTER, delayMs: 0, durationMs: FX_RESULT_MS },
      burst("confetti", CENTER, "area", 0),
      { kind: "crack", at: heroT("opponent"), delayMs: 0, durationMs: 900 },
      burst("shard", heroT("opponent"), "ring", 200),
      burst("smoke", heroT("opponent"), "area", 300),
      shake(0.9, 200),
    ]);
  });

  it("B22 defeat: the Defeat overlay and the viewer's own hero cracking, bursting and smouldering", () => {
    expectCues(planResult(over("p2"), { intensity: 1 }), [
      { kind: "result", outcome: "defeat", text: "Defeat", delayMs: 0, durationMs: FX_RESULT_MS },
      { kind: "crack", at: heroT("you"), delayMs: 0, durationMs: 900 },
      burst("shard", heroT("you"), "ring", 200),
      burst("smoke", heroT("you"), "area", 300),
      burst("ember", heroT("you"), "area", 300),
      shake(0.9, 200),
    ]);
  });

  it("B22 draw: the Draw overlay and a dust puff on both heroes", () => {
    expectCues(planResult(over("draw"), { intensity: 1 }), [
      { kind: "result", outcome: "draw", text: "Draw", delayMs: 0, durationMs: FX_RESULT_MS },
      burst("dust", heroT("you"), "area", 0),
      burst("dust", heroT("opponent"), "area", 0),
    ]);
  });

  it("B22 a draw never shakes, cracks or throws confetti", () => {
    const cues = planResult(over("draw"), { intensity: FX_INTENSITY_SCALE.high });
    expect(shakesOf(cues)).toEqual([]);
    expect(cues.some((c) => c.kind === "crack")).toBe(false);
    expect(cues.some((c) => c.kind === "burst" && c.preset === "confetti")).toBe(false);
  });

  it("B22 the outcome is relative to the viewer", () => {
    const asP2 = over("p2", { viewer: "p2", you: emptySide("p2"), opponent: emptySide("p1", { hand: { count: 2 } }) });
    const cues = planResult(asP2, { intensity: 1 });
    expect(cues.find((c) => c.kind === "result")).toMatchObject({ outcome: "victory", text: "Victory" });
    expect(cues.find((c) => c.kind === "crack")).toMatchObject({ at: heroT("opponent") });
  });

  it("B22 every result cue ends by FX_RESULT_MS", () => {
    expect(FX_RESULT_MS).toBe(3200);
    for (const winner of ["p1", "p2", "draw"] as const) {
      const cues = planResult(over(winner), { intensity: FX_INTENSITY_SCALE.high });
      expect(cues.length).toBeGreaterThan(0);
      for (const cue of cues) {
        const end = cue.delayMs + ("durationMs" in cue ? cue.durationMs : 0);
        expect(end, `${winner}: ${JSON.stringify(cue)}`).toBeLessThanOrEqual(FX_RESULT_MS);
        expect(cue.delayMs).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("B22 a view without a result plans no result sequence", () => {
    expect(planResult(fullBoardView(), { intensity: 1 })).toEqual([]);
    expect(planResult(baseView(), { intensity: FX_INTENSITY_SCALE.high })).toEqual([]);
  });

  it("B22 planResult at intensity 0 plans nothing, and scales its shake otherwise", () => {
    expect(planResult(over("p1"), { intensity: 0 })).toEqual([]);
    expect(shakesOf(planResult(over("p1"), { intensity: FX_INTENSITY_SCALE.low })).map(round6)).toEqual([round6(0.9 * 0.45)]);
    expect(shakesOf(planResult(over("p1"), { intensity: FX_INTENSITY_SCALE.high }))).toEqual([1]);
  });

  it("B22 planHandover plans a Your turn banner with rays when the viewer is active", () => {
    expectCues(planHandover(baseView({ active: "p1", phase: "main" }), { intensity: 1 }), [
      banner("Your turn", "you", FX_HANDOVER_BANNER_MS),
      { kind: "rays", tone: "victory", at: CENTER, delayMs: 0, durationMs: FX_HANDOVER_BANNER_MS },
    ]);
    expect(FX_HANDOVER_BANNER_MS).toBe(1400);
  });

  it("B22 planHandover plans nothing when the viewer is not the active player", () => {
    expect(planHandover(baseView({ active: "p2" }), { intensity: 1 })).toEqual([]);
  });

  it("B22 planHandover plans nothing during the mulligan", () => {
    expect(planHandover(baseView({ active: "p1", phase: "mulligan" }), { intensity: 1 })).toEqual([]);
  });

  it("B22 planHandover plans nothing once the game has a result", () => {
    expect(planHandover(baseView({ active: "p1", phase: "over", result: { winner: "p1", reason: "concede" } }), { intensity: 1 })).toEqual([]);
  });

  it("B22 planHandover plans nothing at intensity 0", () => {
    expect(planHandover(baseView({ active: "p1" }), { intensity: 0 })).toEqual([]);
  });
});

/* ------------------------------------------------------------------------------------------- *
 * Review fixes: the killing blow, and projectiles that scale with intensity
 * ------------------------------------------------------------------------------------------- */

describe("R200 planLethal: the killing blow a drained game over never drew", () => {
  const finished = (winner: "p1" | "p2" | "draw") =>
    fullBoardView({ result: { winner, reason: "hero-death" }, phase: "over" });
  const entriesOf = (events: GameEvent[], D: number): AnimationEntry[] =>
    planEntries(events, withEvents(fullBoardView(), events), false).map((entry) => ({ ...entry, durationMs: D }));

  it("R200 the last entry that hits the losing hero is planned again, and the result waits for it (B49)", () => {
    const entries = entriesOf(
      [
        { type: "attackDeclared", attackerId: MINE, targetId: "hero-p2", forced: false },
        dmg(MINE, "hero-p2", 5, true),
        { type: "turnEnded", player: "p1", turn: 3, unspentMana: 0 },
      ],
      300,
    );
    const env = envOf();
    const lethal = planLethal(entries, finished("p1"), env);
    expect(lethal.leadMs).toBe(300);
    expectCues(lethal.cues, [
      burst("spark", heroT("opponent"), "point", 0),
      splat("damage", 5, heroT("opponent"), 0, 300),
      shake(0.75 * 1.25, 0),
    ]);
  });

  it("R200 a spell's lethal bolt flies again from the caster the drained entries remember", () => {
    const entries = entriesOf([played("p2", "s9", "core-070"), dmg("s9", "hero-p1", 6, false)], 300);
    const env = envOf();
    for (const entry of entries) env.memory.remember(entry.events);
    const lethal = planLethal(entries, finished("p2"), env);
    const bolt = lethal.cues.find((cue) => cue.kind === "projectile");
    expect(bolt).toMatchObject({ preset: "fire", from: heroT("opponent"), to: heroT("you") });
    expect(lethal.cues.some((cue) => cue.kind === "splat" && cue.at.kind === "testid" && cue.at.testid === testid.hero("you"))).toBe(true);
  });

  it("R200 the replay never takes longer than FX_LETHAL_LEAD_MAX_MS, whatever the entry had", () => {
    const entries = entriesOf([dmg(MINE, "hero-p2", 9, true)], 2_000);
    const lethal = planLethal(entries, finished("p1"), envOf());
    expect(lethal.leadMs).toBe(FX_LETHAL_LEAD_MAX_MS);
    for (const cue of lethal.cues) expect(cue.delayMs).toBeLessThanOrEqual(FX_LETHAL_LEAD_MAX_MS);
  });

  it("R200 health loss counts, a hit on the winner does not, and a draw takes either hero", () => {
    const loss: GameEvent = { type: "healthLost", player: "p2", amount: 3 };
    expect(planLethal(entriesOf([loss], 300), finished("p1"), envOf()).leadMs).toBe(300);
    expect(planLethal(entriesOf([dmg(ENEMY, "hero-p1", 3, true)], 300), finished("p1"), envOf())).toEqual({ cues: [], leadMs: 0 });
    expect(planLethal(entriesOf([dmg(ENEMY, "hero-p1", 3, true)], 300), finished("draw"), envOf()).leadMs).toBe(300);
  });

  it("R200 nothing is replayed for a concession, at intensity 0, without a result, or for entries planned for the other seat", () => {
    expect(planLethal(entriesOf([{ type: "turnEnded", player: "p1", turn: 3, unspentMana: 0 }], 150), finished("p1"), envOf())).toEqual({ cues: [], leadMs: 0 });
    const hit = entriesOf([dmg(MINE, "hero-p2", 5, true)], 300);
    expect(planLethal(hit, finished("p1"), envOf({ intensity: 0 }))).toEqual({ cues: [], leadMs: 0 });
    expect(planLethal(hit, fullBoardView(), envOf())).toEqual({ cues: [], leadMs: 0 });
    const otherSeat = fullBoardView({ viewer: "p2", result: { winner: "p1", reason: "hero-death" }, phase: "over" });
    expect(planLethal(hit, otherSeat, envOf())).toEqual({ cues: [], leadMs: 0 });
  });

  it("R200 delayCues moves every cue later by the lead and changes nothing else", () => {
    const cues = planResult(finished("p1"), { intensity: 1 });
    const later = delayCues(cues, 300);
    expect(later.map((cue) => cue.delayMs)).toEqual(cues.map((cue) => cue.delayMs + 300));
    expect(later.map((cue) => ({ ...cue, delayMs: 0 }))).toEqual(cues.map((cue) => ({ ...cue, delayMs: 0 })));
    expect(delayCues(cues, 0)).toEqual(cues);
  });
});

describe("B9 projectiles carry the intensity as their density", () => {
  it("B9 a bolt's density is the intensity, so a low setting thins its trail as it thins a burst", () => {
    const at = (intensity: number) =>
      plan([dmg(MINE, ENEMY, 4, false)], 300, { env: envOf({ intensity }) }).find((cue) => cue.kind === "projectile");
    expect(at(FX_INTENSITY_SCALE.low)).toMatchObject({ density: FX_INTENSITY_SCALE.low });
    expect(at(FX_INTENSITY_SCALE.normal)).toMatchObject({ density: 1 });
    expect(at(FX_INTENSITY_SCALE.high)).toMatchObject({ density: FX_INTENSITY_SCALE.high });
  });
});
