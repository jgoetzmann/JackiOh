// The cue planner (docs/polish/1-animations.md S6 and S7).
//
// Turns one animation entry into the effects that decorate it: particle bursts, projectiles, cracks,
// rings, a board shake and short DOM flourishes. Every function here is pure. It reads only its
// arguments, never the DOM, and returns plain data the director schedules.
//
// R200: effects pace nothing. Every delay and duration is derived from the duration the runner gave
// the entry (D, `entry.durationMs`) through the constants in `constants.ts`, so for any D an effect
// starts inside the entry (0 <= delay <= D), a projectile lands inside it (delay + flight <= D) and
// whatever trails after it is gone within FX_MAX_TAIL_MS of the entry's end.
//
// R202: effects draw from the redacted stream only. The planner reads the event, the view the entry
// was planned against and the public catalog facts in `env.card`. An id or defId redacted to
// "hidden" is never looked up, so a hidden card plans the same cues whatever it hides, gets no rarity
// entrance, and no cue ever carries a defId or a card name.
//
// CLAUDE.md rule 9: particle counts live in `TUNING`, the game-over timings in `RESULT_TUNING`, and
// every other number in `constants.ts`.

import { hasKeyword, type GameEvent, type PlayerView } from "@jackioh/shared";

import { ANIMATIONS, animTestid, locateInstance, targetFor, type AnimationEntry } from "../game/animations.ts";
import { sideOf, testid, type Side } from "../game/contract.ts";
import {
  FX_ARROWS_TAIL_MS,
  FX_BANNER_TAIL_MS,
  FX_BURN_AT,
  FX_CENTER,
  FX_CRACK_TAIL_MS,
  FX_DEATH_EMBER_AT,
  FX_DEATH_SMOKE_AT,
  FX_FATIGUE_FLIGHT_FRACTION,
  FX_FATIGUE_STREAK_AT,
  FX_FUSE_FLIGHT_FRACTION,
  FX_HANDOVER_BANNER_MS,
  FX_HEAL_SPLAT_AT,
  FX_HERO_TRAUMA_MULT,
  FX_LEGENDARY_TRAUMA,
  FX_LETHAL_LEAD_MAX_MS,
  FX_MANA_MAX_SPARKS,
  FX_MANA_STAGGER_MS,
  FX_MAX_TAIL_MS,
  FX_MIND_CONTROL_FLIGHT_FRACTION,
  FX_OVERFLOW_FIZZLE_AT,
  FX_PROJECTILE_FLIGHT_FRACTION,
  FX_RADIANT_BURST_AT,
  FX_RAYS_TAIL_MS,
  FX_RESULT_MS,
  FX_RESULT_TRAUMA,
  FX_RING_MS,
  FX_SHAKE_MAX_TRAUMA,
  FX_SHAKE_MIN_DAMAGE,
  FX_SLAM_AT,
  FX_SLAM_MAX_TRAUMA,
  FX_SLAM_STATS_MIN,
  FX_SLAM_TRAUMA_PER_STAT,
  FX_SPLAT_HOLD_MS,
  FX_TEXT,
  FX_TRAP_BURST_AT,
  FX_TRAP_TRAUMA,
  FX_TRAUMA_PER_DAMAGE,
} from "./constants.ts";
import type {
  FxAnchor,
  FxBannerTone,
  FxBurstCue,
  FxCrackCue,
  FxCue,
  FxGhostCue,
  FxMemory,
  FxOutcome,
  FxPlanEnv,
  FxPoint,
  FxPreset,
  FxProjectileCue,
  FxRayTone,
  FxRaysCue,
  FxRecipe,
  FxRingCue,
  FxShakeCue,
  FxSplatCue,
  FxSplatTone,
  FxSpread,
} from "./types.ts";

/* ------------------------------------------------------------------------------------------- *
 * Tuning tables (rule 9)
 * ------------------------------------------------------------------------------------------- */

/**
 * Every burst's base particle count at intensity "normal", and the emit power it is thrown with.
 * A planned count is `max(1, round(count × intensity))`; power does not scale with intensity.
 * Every count is at least 6, so "low" plans strictly fewer particles than "normal" and "high" more.
 */
const TUNING = {
  cast: { count: 24, power: 1 },
  castOpponent: { count: 12, power: 0.8 },
  summonDust: { count: 30, power: 1.1 },
  summonGold: { count: 40, power: 1.3 },
  summonPrismatic: { count: 44, power: 1.3 },
  impactSpark: { count: 24, power: 1.2 },
  impactPoison: { count: 20, power: 0.8 },
  drainVoid: { count: 16, power: 0.8 },
  healHoly: { count: 26, power: 0.9 },
  shieldShard: { count: 28, power: 1.3 },
  deathEmber: { count: 36, power: 0.9 },
  deathSmoke: { count: 16, power: 0.7 },
  pileSmoke: { count: 8, power: 0.6 },
  exileVoid: { count: 18, power: 0.9 },
  bounceSmoke: { count: 12, power: 0.7 },
  burnFire: { count: 32, power: 1 },
  burnEmber: { count: 18, power: 0.9 },
  burnGraveEmber: { count: 8, power: 0.6 },
  fatigueDust: { count: 16, power: 0.8 },
  fatigueSmoke: { count: 8, power: 0.6 },
  fatigueVoid: { count: 12, power: 0.8 },
  overflowSmoke: { count: 12, power: 0.7 },
  overflowEmber: { count: 8, power: 0.6 },
  discardEmber: { count: 8, power: 0.6 },
  drawSparkle: { count: 6, power: 0.6 },
  handSparkle: { count: 10, power: 0.7 },
  shuffleArcane: { count: 8, power: 0.6 },
  buffSparkle: { count: 12, power: 0.8 },
  debuffVoid: { count: 12, power: 0.8 },
  keywordHoly: { count: 16, power: 0.9 },
  keywordPoison: { count: 14, power: 0.8 },
  keywordOther: { count: 10, power: 0.8 },
  counterPoison: { count: 12, power: 0.7 },
  counterSparkle: { count: 8, power: 0.7 },
  glintArcane: { count: 8, power: 0.6 },
  radiantGold: { count: 34, power: 1.1 },
  transformSmoke: { count: 10, power: 0.6 },
  transformArcane: { count: 10, power: 0.9 },
  fuseSmoke: { count: 12, power: 0.7 },
  fuseArcane: { count: 20, power: 1 },
  controlArcane: { count: 18, power: 1 },
  lockDust: { count: 12, power: 0.7 },
  trapArcane: { count: 30, power: 1 },
  lungeDust: { count: 12, power: 0.8 },
  fizzleSmoke: { count: 10, power: 0.7 },
  manaSparkle: { count: 6, power: 0.5 },
  resultConfetti: { count: 90, power: 1.4 },
  resultShard: { count: 36, power: 1.5 },
  resultSmoke: { count: 24, power: 0.9 },
  resultEmber: { count: 30, power: 1 },
  resultDust: { count: 16, power: 0.8 },
} as const;

type TuningKey = keyof typeof TUNING;

/** The game-over sequence's own timings (S7 `planResult`), all inside FX_RESULT_MS. */
const RESULT_TUNING = {
  /** How long the loser's hero crack runs. */
  crackMs: 900,
  /** When the hero bursts into shards and the board shakes. */
  impactDelayMs: 200,
  /** When the smoke (and, on a defeat, the embers) rise from the broken hero. */
  smokeDelayMs: 300,
} as const;

/** The bottom centre of a box: where a landing unit kicks up dust. */
const FOOT: FxPoint = { x: 0.5, y: 1 };

const HIDDEN_ID = "hidden";

const SIDES: readonly Side[] = ["you", "opponent"];

/* ------------------------------------------------------------------------------------------- *
 * Anchors
 * ------------------------------------------------------------------------------------------- */

function anchor(id: string, at?: FxPoint): FxAnchor {
  return at === undefined ? { kind: "testid", testid: id } : { kind: "testid", testid: id, at: { x: at.x, y: at.y } };
}

function viewportCenter(): FxAnchor {
  return { kind: "viewport", at: { x: FX_CENTER.x, y: FX_CENTER.y } };
}

const isCard = (tgt: string): boolean => tgt.startsWith("card-");
const isHandCard = (tgt: string): boolean => tgt.startsWith("hand-card-");
const isHero = (tgt: string): boolean => tgt.startsWith("hero-");

/* ------------------------------------------------------------------------------------------- *
 * Cue builders
 * ------------------------------------------------------------------------------------------- */

function frac(fraction: number, durationMs: number): number {
  return Math.round(fraction * durationMs);
}

function burst(
  intensity: number,
  preset: FxPreset,
  at: FxAnchor,
  spread: FxSpread,
  delayMs: number,
  key: TuningKey,
): FxBurstCue {
  const tuning = TUNING[key];
  return {
    kind: "burst",
    preset,
    at,
    delayMs,
    count: Math.max(1, Math.round(tuning.count * intensity)),
    spread,
    power: tuning.power,
  };
}

/** `density` is the intensity: it scales the trail and the arrival burst as `count` scales a burst. */
function projectile(intensity: number, preset: FxPreset, from: FxAnchor, to: FxAnchor, flightMs: number): FxProjectileCue {
  return { kind: "projectile", preset, from, to, delayMs: 0, flightMs, density: intensity };
}

function ring(D: number, preset: FxPreset, at: FxAnchor, delayMs: number): FxRingCue {
  return { kind: "ring", preset, at, delayMs, durationMs: Math.min(FX_RING_MS, D - delayMs + FX_MAX_TAIL_MS) };
}

function rays(D: number, tone: FxRayTone, at: FxAnchor, delayMs: number): FxRaysCue {
  return { kind: "rays", tone, at, delayMs, durationMs: D - delayMs + FX_RAYS_TAIL_MS };
}

function splat(D: number, tone: FxSplatTone, amount: number, at: FxAnchor, delayMs: number): FxSplatCue {
  return { kind: "splat", tone, amount, at, delayMs, durationMs: D - delayMs + FX_SPLAT_HOLD_MS };
}

function crack(D: number, at: FxAnchor, delayMs: number): FxCrackCue {
  return { kind: "crack", at, delayMs, durationMs: D - delayMs + FX_CRACK_TAIL_MS };
}

function ghost(D: number, from: FxAnchor, to: FxAnchor): FxGhostCue {
  return { kind: "ghost", from, to, delayMs: 0, durationMs: D };
}

function banner(D: number, text: string, tone: FxBannerTone): FxCue {
  return { kind: "banner", text, tone, delayMs: 0, durationMs: D + FX_BANNER_TAIL_MS };
}

/** Appends a shake of `min(1, base × intensity)` at `delayMs`, only when that is above 0. */
function pushShake(cues: FxCue[], intensity: number, base: number, delayMs: number): void {
  const trauma = Math.min(1, base * intensity);
  if (trauma > 0) {
    const cue: FxShakeCue = { kind: "shake", trauma, delayMs };
    cues.push(cue);
  }
}

/* ------------------------------------------------------------------------------------------- *
 * Sources
 * ------------------------------------------------------------------------------------------- */

type FxSourceKind = "unit" | "backrow" | "hand" | "trap" | "hero";

/** Where `id` is rendered in `view` and as what, mirroring `locateInstance`'s search order. */
function renderedSource(view: PlayerView, id: string): { anchor: FxAnchor; kind: FxSourceKind } | null {
  for (const side of SIDES) {
    const sv = side === "you" ? view.you : view.opponent;
    for (const unit of sv.units) {
      if (unit !== null && unit.instanceId === id) return { anchor: anchor(testid.card(id)), kind: "unit" };
    }
    for (const slot of sv.backrow) {
      if (slot !== null && slot.faceDown === false && slot.instanceId === id) {
        return { anchor: anchor(testid.card(id)), kind: "backrow" };
      }
    }
  }
  const hand = view.you.hand;
  if (Array.isArray(hand) && hand.some((card) => card.instanceId === id)) {
    return { anchor: anchor(testid.handCard(id)), kind: "hand" };
  }
  return null;
}

/** True when `sourceId` is a unit on either board of `view` that has Poisonous. */
function sourceIsPoisonous(sourceId: string | null, view: PlayerView): boolean {
  if (sourceId === null || sourceId === HIDDEN_ID) return false;
  for (const side of SIDES) {
    const sv = side === "you" ? view.you : view.opponent;
    for (const unit of sv.units) {
      if (unit !== null && unit.instanceId === sourceId) return hasKeyword(unit.keywords, "Poisonous");
    }
  }
  return false;
}

/** Where a non-combat damage source is: rendered instance → remembered trap zone → caster's hero → null. */
export function sourceAnchor(
  sourceId: string | null,
  view: PlayerView,
  memory: FxMemory,
): { anchor: FxAnchor; kind: FxSourceKind } | null {
  if (sourceId === null || sourceId === HIDDEN_ID) return null;
  const rendered = renderedSource(view, sourceId);
  if (rendered !== null) return rendered;
  const zone = memory.trapZoneOf(sourceId);
  if (zone !== undefined) {
    return { anchor: anchor(testid.zone(sideOf(view, zone.player), zone.row, zone.lane)), kind: "trap" };
  }
  const caster = memory.casterOf(sourceId);
  if (caster !== undefined) return { anchor: anchor(testid.hero(sideOf(view, caster))), kind: "hero" };
  return null;
}

/* ------------------------------------------------------------------------------------------- *
 * Recipes: one per FxRecipe (S7)
 * ------------------------------------------------------------------------------------------- */

type Plan = {
  entry: AnimationEntry;
  view: PlayerView;
  env: FxPlanEnv;
  /** The duration the runner gave this entry. */
  D: number;
  /** `targetFor(event, view)`, never null here. */
  tgt: string;
};

type Recipe = (event: GameEvent, p: Plan) => FxCue[];

const cast: Recipe = (event, p) => {
  if (event.type !== "cardPlayed") return [];
  const paired = p.entry.events.some((e) => e.type === "summoned" && e.instanceId === event.instanceId);
  if (paired) return [];
  const at = anchor(p.tgt);
  if (isCard(p.tgt) || isHandCard(p.tgt)) {
    return [burst(p.env.intensity, "arcane", at, "area", 0, "cast"), ring(p.D, "arcane", at, 0)];
  }
  return [burst(p.env.intensity, "arcane", at, "point", 0, "castOpponent")];
};

const summon: Recipe = (event, p) => {
  if (event.type !== "summoned") return [];
  const i = p.env.intensity;
  const slam = frac(FX_SLAM_AT, p.D);
  const facts = event.row === "units" && event.defId !== HIDDEN_ID ? p.env.card(event.defId) : undefined;
  if (facts === undefined) return [burst(i, "dust", anchor(p.tgt, FOOT), "ring", slam, "summonDust")];

  const at = anchor(p.tgt);
  const cues: FxCue[] = [ring(p.D, "dust", at, slam), burst(i, "dust", anchor(p.tgt, FOOT), "ring", slam, "summonDust")];
  let entrance = 0;
  if (facts.rarity === "Legendary") {
    cues.push(rays(p.D, "legendary", at, 0), burst(i, "gold", at, "area", slam, "summonGold"));
    entrance = FX_LEGENDARY_TRAUMA;
  } else if (facts.rarity === "Mythic") {
    cues.push(rays(p.D, "mythic", at, 0), burst(i, "prismatic", at, "area", slam, "summonPrismatic"));
    entrance = FX_LEGENDARY_TRAUMA;
  }
  const stats = (facts.attack ?? 0) + (facts.health ?? 0);
  const slamTrauma =
    stats >= FX_SLAM_STATS_MIN
      ? Math.min(FX_SLAM_MAX_TRAUMA, (stats - FX_SLAM_STATS_MIN + 1) * FX_SLAM_TRAUMA_PER_STAT)
      : 0;
  pushShake(cues, i, slamTrauma + entrance, slam);
  return cues;
};

const impact: Recipe = (event, p) => {
  if (event.type !== "damage") return [];
  const i = p.env.intensity;
  const at = anchor(p.tgt);
  const poisonous = sourceIsPoisonous(event.sourceId, p.view);
  const cues: FxCue[] = [];
  let hit = 0;
  if (!event.combat) {
    const src = sourceAnchor(event.sourceId, p.view, p.env.memory);
    if (src !== null && src.anchor.kind === "testid" && src.anchor.testid !== p.tgt) {
      const flight = frac(FX_PROJECTILE_FLIGHT_FRACTION, p.D);
      const preset: FxPreset =
        src.kind === "unit" && poisonous ? "poison" : src.kind === "hand" || src.kind === "hero" ? "fire" : "arcane";
      cues.push(projectile(i, preset, src.anchor, at, flight));
      hit = flight;
    }
  }
  cues.push(burst(i, "spark", at, "point", hit, "impactSpark"));
  if (event.amount > 0) cues.push(splat(p.D, "damage", event.amount, at, hit));
  if (poisonous) cues.push(burst(i, "poison", at, "area", hit, "impactPoison"));
  const base =
    event.amount < FX_SHAKE_MIN_DAMAGE ? 0 : Math.min(FX_SHAKE_MAX_TRAUMA, event.amount * FX_TRAUMA_PER_DAMAGE);
  pushShake(cues, i, isHero(p.tgt) ? base * FX_HERO_TRAUMA_MULT : base, hit);
  return cues;
};

const drain: Recipe = (event, p) => {
  if (event.type !== "healthLost") return [];
  const at = anchor(p.tgt);
  return [burst(p.env.intensity, "void", at, "area", 0, "drainVoid"), splat(p.D, "loss", event.amount, at, 0)];
};

const heal: Recipe = (event, p) => {
  if (event.type !== "healed") return [];
  const at = anchor(p.tgt);
  return [
    rays(p.D, "holy", at, 0),
    burst(p.env.intensity, "holy", at, "area", 0, "healHoly"),
    splat(p.D, "heal", event.amount, at, frac(FX_HEAL_SPLAT_AT, p.D)),
  ];
};

const shieldBreak: Recipe = (event, p) => {
  if (event.type !== "divineShieldLost") return [];
  const at = anchor(p.tgt);
  return [ring(p.D, "gold", at, 0), burst(p.env.intensity, "shard", at, "ring", 0, "shieldShard")];
};

const death: Recipe = (event, p) => {
  if (event.type !== "destroyed") return [];
  const i = p.env.intensity;
  const at = anchor(p.tgt);
  if (!isCard(p.tgt)) return [burst(i, "smoke", at, "point", 0, "pileSmoke")];
  return [
    crack(p.D, at, 0),
    burst(i, "ember", at, "area", frac(FX_DEATH_EMBER_AT, p.D), "deathEmber"),
    burst(i, "smoke", at, "area", frac(FX_DEATH_SMOKE_AT, p.D), "deathSmoke"),
  ];
};

const exile: Recipe = (event, p) => {
  if (event.type !== "exiled") return [];
  const at = anchor(p.tgt);
  return [ring(p.D, "void", at, 0), burst(p.env.intensity, "void", at, "area", 0, "exileVoid")];
};

const bounce: Recipe = (event, p) => {
  if (event.type !== "bounced") return [];
  const at = anchor(p.tgt);
  const cues: FxCue[] = [burst(p.env.intensity, "smoke", at, "area", 0, "bounceSmoke")];
  if (isCard(p.tgt)) cues.push(ghost(p.D, at, anchor(animTestid.hand(sideOf(p.view, event.owner)))));
  return cues;
};

/**
 * R318: the card a full hand cannot take burns over it, and what is left of it reaches the graveyard
 * as the entry ends. The card itself is the board's `burn-notice` (face or back by R97); this only
 * lights it.
 */
const burn: Recipe = (event, p) => {
  if (event.type !== "burned") return [];
  const at = anchor(p.tgt);
  const delay = frac(FX_BURN_AT, p.D);
  return [
    burst(p.env.intensity, "fire", at, "area", delay, "burnFire"),
    burst(p.env.intensity, "ember", at, "area", delay, "burnEmber"),
    burst(p.env.intensity, "ember", anchor(animTestid.graveyard(sideOf(p.view, event.owner))), "point", p.D, "burnGraveEmber"),
  ];
};

const discard: Recipe = (event, p) => {
  if (event.type !== "discarded") return [];
  const graveyard = animTestid.graveyard(sideOf(p.view, event.owner));
  return [
    ghost(p.D, anchor(p.tgt), anchor(graveyard)),
    burst(p.env.intensity, "ember", anchor(graveyard), "point", p.D, "discardEmber"),
  ];
};

const draw: Recipe = (event, p) => {
  if (event.type !== "drawn") return [];
  const side = sideOf(p.view, event.player);
  return [
    ghost(p.D, anchor(animTestid.library(side)), anchor(animTestid.hand(side))),
    burst(p.env.intensity, "sparkle", anchor(animTestid.hand(side)), "point", p.D, "drawSparkle"),
  ];
};

const handGlint: Recipe = (event, p) => {
  if (event.type !== "addedToHand") return [];
  const side = sideOf(p.view, event.player);
  return [burst(p.env.intensity, "sparkle", anchor(animTestid.hand(side)), "area", 0, "handSparkle")];
};

const shuffle: Recipe = (event, p) => {
  if (event.type !== "shuffledIn") return [];
  const library = animTestid.library(sideOf(p.view, event.player));
  return [
    ghost(p.D, viewportCenter(), anchor(library)),
    burst(p.env.intensity, "arcane", anchor(library), "point", p.D, "shuffleArcane"),
  ];
};

const buff: Recipe = (event, p) => {
  if (event.type !== "buffed") return [];
  const net = event.attack + event.health;
  const at = anchor(p.tgt);
  if (net > 0) {
    return [
      { kind: "arrows", direction: "up", at, delayMs: 0, durationMs: p.D + FX_ARROWS_TAIL_MS },
      burst(p.env.intensity, "sparkle", at, "area", 0, "buffSparkle"),
    ];
  }
  if (net < 0) {
    return [
      { kind: "arrows", direction: "down", at, delayMs: 0, durationMs: p.D + FX_ARROWS_TAIL_MS },
      burst(p.env.intensity, "void", at, "area", 0, "debuffVoid"),
    ];
  }
  return [];
};

const keyword: Recipe = (event, p) => {
  if (event.type !== "keywordGranted") return [];
  const i = p.env.intensity;
  const at = anchor(p.tgt);
  switch (event.keyword.kind) {
    case "Divine Shield":
      return [ring(p.D, "gold", at, 0), burst(i, "holy", at, "ring", 0, "keywordHoly")];
    case "Poisonous":
      return [burst(i, "poison", at, "area", 0, "keywordPoison")];
    case "Taunt":
      return [ring(p.D, "dust", at, 0)];
    default:
      return [burst(i, "arcane", at, "point", 0, "keywordOther")];
  }
};

const counter: Recipe = (event, p) => {
  if (event.type !== "counterChanged") return [];
  const at = anchor(p.tgt);
  if (event.counter === "plague") return [burst(p.env.intensity, "poison", at, "area", 0, "counterPoison")];
  return [burst(p.env.intensity, "sparkle", at, "point", 0, "counterSparkle")];
};

const glint: Recipe = (event, p) => {
  if (event.type === "costChanged") return [burst(p.env.intensity, "arcane", anchor(p.tgt), "point", 0, "glintArcane")];
  if (event.type === "modifierChanged" && event.added) {
    return [burst(p.env.intensity, "arcane", anchor(p.tgt), "point", 0, "glintArcane")];
  }
  return [];
};

const radiant: Recipe = (event, p) => {
  if (event.type !== "radiantSet") return [];
  const at = anchor(p.tgt);
  const cues: FxCue[] = [
    { kind: "sheen", at, delayMs: 0, durationMs: p.D },
    burst(p.env.intensity, "gold", at, "area", frac(FX_RADIANT_BURST_AT, p.D), "radiantGold"),
  ];
  if (isCard(p.tgt)) cues.push(rays(p.D, "radiant", at, 0));
  return cues;
};

const smoke: Recipe = (event, p) => {
  if (event.type !== "transformed") return [];
  const at = anchor(p.tgt);
  // Centred on the unit that changed, and light: an area of big puffs read as smoke drifting over
  // the neighbouring lanes on a phone (integration QA).
  return [
    burst(p.env.intensity, "smoke", at, "point", 0, "transformSmoke"),
    burst(p.env.intensity, "arcane", at, "point", 0, "transformArcane"),
  ];
};

const fuse: Recipe = (event, p) => {
  if (event.type !== "fused") return [];
  const i = p.env.intensity;
  const at = anchor(p.tgt);
  const flight = frac(FX_FUSE_FLIGHT_FRACTION, p.D);
  const cues: FxCue[] = [burst(i, "smoke", at, "area", 0, "fuseSmoke")];
  for (const id of event.instanceIds) {
    if (id === HIDDEN_ID) continue;
    const other = locateInstance(p.view, id);
    if (other === null || other === p.tgt) continue;
    const from = anchor(other);
    cues.push(burst(i, "smoke", from, "area", 0, "fuseSmoke"), projectile(i, "arcane", from, at, flight));
  }
  cues.push(burst(i, "arcane", at, "area", flight, "fuseArcane"));
  return cues;
};

const mindControl: Recipe = (event, p) => {
  if (event.type !== "controlChanged") return [];
  const i = p.env.intensity;
  const at = anchor(p.tgt);
  const from = event.instanceId === HIDDEN_ID ? null : locateInstance(p.view, event.instanceId);
  if (from === null) return [burst(i, "arcane", at, "area", 0, "controlArcane")];
  const flight = frac(FX_MIND_CONTROL_FLIGHT_FRACTION, p.D);
  return [projectile(i, "arcane", anchor(from), at, flight), burst(i, "arcane", at, "area", flight, "controlArcane")];
};

const lock: Recipe = (event, p) => {
  if (event.type !== "locked") return [];
  const at = anchor(p.tgt);
  return [ring(p.D, "dust", at, 0), burst(p.env.intensity, "dust", at, "area", 0, "lockDust")];
};

const trap: Recipe = (event, p) => {
  if (event.type !== "trapFired") return [];
  const at = anchor(p.tgt);
  const delay = frac(FX_TRAP_BURST_AT, p.D);
  // A tight arcane ring on the trap's own zone, not motes over the whole area (integration QA).
  const cues: FxCue[] = [ring(p.D, "arcane", at, 0), burst(p.env.intensity, "arcane", at, "ring", delay, "trapArcane")];
  pushShake(cues, p.env.intensity, FX_TRAP_TRAUMA, delay);
  return cues;
};

const lunge: Recipe = (event, p) => {
  if (event.type !== "attackDeclared") return [];
  return [burst(p.env.intensity, "dust", anchor(p.tgt, FOOT), "point", 0, "lungeDust")];
};

const fizzle: Recipe = (event, p) => {
  if (event.type !== "attackCancelled") return [];
  return [burst(p.env.intensity, "smoke", anchor(p.tgt), "point", 0, "fizzleSmoke")];
};

const mana: Recipe = (event, p) => {
  if (event.type !== "manaChanged") return [];
  const side = sideOf(p.view, event.player);
  const old = (side === "you" ? p.view.you : p.view.opponent).mana.current;
  const n = Math.min(event.current, old + FX_MANA_MAX_SPARKS) - old;
  if (n <= 0) return [];
  const step = Math.min(FX_MANA_STAGGER_MS, Math.floor(p.D / Math.max(n, 1)));
  const cues: FxCue[] = [];
  for (let k = 0; k < n; k += 1) {
    const crystal: FxAnchor = { kind: "crystal", side, index: old + k };
    cues.push(burst(p.env.intensity, "sparkle", crystal, "point", Math.min(p.D, k * step), "manaSparkle"));
  }
  return cues;
};

const turnBanner: Recipe = (event, p) => {
  if (event.type === "turnAutoEnded") return [banner(p.D, FX_TEXT.autoEnded, "muted")];
  if (event.type !== "turnStarted") return [];
  if (event.player === p.view.viewer) {
    return [banner(p.D, FX_TEXT.yourTurn, "you"), rays(p.D, "victory", viewportCenter(), 0)];
  }
  return [banner(p.D, FX_TEXT.opponentTurn, "opponent")];
};

/**
 * R315, R318: a draw finds the library empty. Dust and a little smoke puff out of the pile at once,
 * then void wisps streak from it to its owner's hero, landing just inside the entry (R200), where the
 * `damage` entry after it pops the number and shakes by the amount.
 */
const fatigue: Recipe = (event, p) => {
  if (event.type !== "fatigue") return [];
  const i = p.env.intensity;
  const at = anchor(p.tgt);
  const hero = anchor(testid.hero(sideOf(p.view, event.player)));
  const leave = frac(FX_FATIGUE_STREAK_AT, p.D);
  const flight = frac(FX_FATIGUE_FLIGHT_FRACTION, p.D);
  const streak: FxProjectileCue = { kind: "projectile", preset: "void", from: at, to: hero, delayMs: leave, flightMs: flight, density: i };
  return [
    burst(i, "dust", at, "area", 0, "fatigueDust"),
    burst(i, "smoke", at, "point", 0, "fatigueSmoke"),
    streak,
    burst(i, "void", hero, "point", leave + flight, "fatigueVoid"),
  ];
};

/**
 * R316, R318: a full library turns a card away. A refusal ring flares on the pile; a card that was
 * never made, or has ceased to exist, fizzles into smoke there, and one sent to the graveyard flies
 * there as a card back (R202: a ghost never names a card) and lands in embers. The card's face, when
 * the viewer may read it, is the board's `overflow-card`, not an effect.
 */
const overflow: Recipe = (event, p) => {
  if (event.type !== "libraryOverflow") return [];
  const i = p.env.intensity;
  const at = anchor(p.tgt);
  const cues: FxCue[] = [ring(p.D, "fire", at, 0)];
  if (event.outcome === "graveyard") {
    const graveyard = anchor(animTestid.graveyard(sideOf(p.view, event.player)));
    cues.push(ghost(p.D, at, graveyard), burst(i, "ember", graveyard, "point", p.D, "overflowEmber"));
    return cues;
  }
  cues.push(burst(i, "smoke", at, "point", frac(FX_OVERFLOW_FIZZLE_AT, p.D), "overflowSmoke"));
  return cues;
};

const RECIPES: { readonly [R in FxRecipe]: Recipe } = {
  cast,
  summon,
  impact,
  drain,
  heal,
  shieldBreak,
  death,
  void: exile,
  bounce,
  burn,
  discard,
  draw,
  handGlint,
  shuffle,
  buff,
  keyword,
  counter,
  glint,
  radiant,
  smoke,
  fuse,
  mindControl,
  lock,
  trap,
  lunge,
  fizzle,
  mana,
  banner: turnBanner,
  fatigue,
  overflow,
};

/* ------------------------------------------------------------------------------------------- *
 * Public planners (S6)
 * ------------------------------------------------------------------------------------------- */

/** Plans every event of one entry: each event's row recipe, in event order, concatenated. */
export function planFx(entry: AnimationEntry, view: PlayerView, env: FxPlanEnv): FxCue[] {
  if (!(env.intensity > 0)) return [];
  const cues: FxCue[] = [];
  for (const event of entry.events) {
    const recipe = ANIMATIONS[event.type].fx?.recipe;
    if (recipe === undefined) continue;
    const tgt = targetFor(event, view);
    if (tgt === null) continue;
    cues.push(...RECIPES[recipe](event, { entry, view, env, D: entry.durationMs, tgt }));
  }
  return cues;
}

/** The game-over sequence for a view with a result; [] when view.result is null. */
export function planResult(view: PlayerView, env: Pick<FxPlanEnv, "intensity">): FxCue[] {
  const i = env.intensity;
  if (!(i > 0) || view.result === null) return [];
  const you = anchor(testid.hero("you"));
  const opponent = anchor(testid.hero("opponent"));
  const winner = view.result.winner;

  if (winner === "draw") {
    return [
      resultCue("draw", FX_TEXT.draw),
      burst(i, "dust", you, "area", 0, "resultDust"),
      burst(i, "dust", opponent, "area", 0, "resultDust"),
    ];
  }

  const cues: FxCue[] = [];
  if (winner === view.viewer) {
    const rayCue: FxRaysCue = { kind: "rays", tone: "victory", at: viewportCenter(), delayMs: 0, durationMs: FX_RESULT_MS };
    cues.push(
      resultCue("victory", FX_TEXT.victory),
      rayCue,
      burst(i, "confetti", viewportCenter(), "area", 0, "resultConfetti"),
      { kind: "crack", at: opponent, delayMs: 0, durationMs: RESULT_TUNING.crackMs },
      burst(i, "shard", opponent, "ring", RESULT_TUNING.impactDelayMs, "resultShard"),
      burst(i, "smoke", opponent, "area", RESULT_TUNING.smokeDelayMs, "resultSmoke"),
    );
  } else {
    cues.push(
      resultCue("defeat", FX_TEXT.defeat),
      { kind: "crack", at: you, delayMs: 0, durationMs: RESULT_TUNING.crackMs },
      burst(i, "shard", you, "ring", RESULT_TUNING.impactDelayMs, "resultShard"),
      burst(i, "smoke", you, "area", RESULT_TUNING.smokeDelayMs, "resultSmoke"),
      burst(i, "ember", you, "area", RESULT_TUNING.smokeDelayMs, "resultEmber"),
    );
  }
  pushShake(cues, i, FX_RESULT_TRAUMA, RESULT_TUNING.impactDelayMs);
  return cues;
}

/**
 * The killing blow, replayed ahead of the game-over sequence.
 *
 * A result settles the runner at once (Game.tsx drains it the moment a finished view arrives), so the
 * entry that dealt the lethal damage is cleared before it ever draws: without this, the last hit of the
 * match (the lunge's impact, the Fireball, the splat on the hero) would never show. `entries` are the
 * ones the drain cut short, in order. This takes the last of them whose `damage` or `healthLost` lands
 * on a losing hero and plans it again, given its own duration but never more than
 * FX_LETHAL_LEAD_MAX_MS, and reports that duration as `leadMs`, the beat the result waits for.
 *
 * Pure, like `planFx`: the caller remembers the drained entries' events in `env.memory` first, so a
 * spell's caster is known. Nothing is replayed when the entries were planned for another seat (a
 * hot-seat hand-over), because their `hero-you` would be the other hero now.
 */
export function planLethal(
  entries: readonly AnimationEntry[],
  view: PlayerView,
  env: FxPlanEnv,
): { cues: FxCue[]; leadMs: number } {
  const none = { cues: [], leadMs: 0 };
  if (!(env.intensity > 0) || view.result === null) return none;
  const winner = view.result.winner;
  const losers: readonly Side[] = winner === "draw" ? SIDES : [winner === view.viewer ? "opponent" : "you"];
  const heroes = new Set(losers.map((side) => testid.hero(side)));
  for (let k = entries.length - 1; k >= 0; k -= 1) {
    const entry = entries[k];
    if (entry === undefined || entry.view.viewer !== view.viewer) continue;
    const lethal = entry.events.some((event) => {
      if (event.type !== "damage" && event.type !== "healthLost") return false;
      const tgt = targetFor(event, entry.view);
      return tgt !== null && heroes.has(tgt);
    });
    if (!lethal) continue;
    // R318: a fatigue hit comes out of an empty library, and the entry just before it says so. A
    // lethal one is replayed with it, the two sharing the same lead, so the killing blow is not a hit
    // from nowhere; the board's "Fatigue N" never mounts under a finished view.
    const before = entries[k - 1];
    const fatigue =
      before !== undefined &&
      before.view.viewer === view.viewer &&
      before.events.some((event) => event.type === "fatigue" && heroes.has(testid.hero(sideOf(before.view, event.player))));
    if (fatigue) {
      const leadMs = Math.min(before.durationMs + entry.durationMs, FX_LETHAL_LEAD_MAX_MS);
      const emptyMs = Math.round((leadMs * before.durationMs) / (before.durationMs + entry.durationMs));
      const hitMs = leadMs - emptyMs;
      return {
        cues: [
          ...planFx({ ...before, durationMs: emptyMs }, before.view, env),
          ...delayCues(planFx({ ...entry, durationMs: hitMs }, entry.view, env), emptyMs),
        ],
        leadMs,
      };
    }
    const leadMs = Math.min(entry.durationMs, FX_LETHAL_LEAD_MAX_MS);
    return { cues: planFx({ ...entry, durationMs: leadMs }, entry.view, env), leadMs };
  }
  return none;
}

/** The same cues, each `ms` later. */
export function delayCues(cues: readonly FxCue[], ms: number): FxCue[] {
  return ms > 0 ? cues.map((cue) => ({ ...cue, delayMs: cue.delayMs + ms })) : [...cues];
}

function resultCue(outcome: FxOutcome, text: string): FxCue {
  return { kind: "result", outcome, text, delayMs: 0, durationMs: FX_RESULT_MS };
}

/** The "Your turn" banner on a hot-seat hand-over; [] unless active === viewer, phase ≠ "mulligan", no result. */
export function planHandover(view: PlayerView, env: Pick<FxPlanEnv, "intensity">): FxCue[] {
  if (!(env.intensity > 0)) return [];
  if (view.active !== view.viewer || view.phase === "mulligan" || view.result !== null) return [];
  const rayCue: FxRaysCue = {
    kind: "rays",
    tone: "victory",
    at: viewportCenter(),
    delayMs: 0,
    durationMs: FX_HANDOVER_BANNER_MS,
  };
  return [
    { kind: "banner", text: FX_TEXT.yourTurn, tone: "you", delayMs: 0, durationMs: FX_HANDOVER_BANNER_MS },
    rayCue,
  ];
}
