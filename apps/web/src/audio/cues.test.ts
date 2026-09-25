// The cue table (docs/polish/2-sound.md, B17 to B23), and the proofs of R203 (what audio may
// reveal) and R204 (which moments speak) at the level of a single event.
//
// Every test builds its own CueContext from `baseView()` (viewer p1) and an inline voice table, so
// these rows are checked against the table's rules and not against the shipped lines' content.
// "Readable" is the design's word: the defId is not the sentinel and the table has an entry for it.

import { GAME_EVENT_TYPES, type GameEvent, type GameEventType, type PlayerId } from "@jackioh/shared";
import { describe, expect, it } from "vitest";

import { DEATH_VOICE_DELAY_MS, HIDDEN_DEF_ID, VOICE_DELAY_MS, VOICE_PRIORITY } from "./constants.ts";
import { SOUND_CUES, cuesFor, timbreFor, type CueCard, type CueContext } from "./cues.ts";
import { SFX_IDS } from "./sfx.ts";
import type { SfxId, SoundCue, VoiceLineTable } from "./types.ts";
import { baseView, emptySide, unit } from "../test/fixtures.ts";

/* --------------------------------------------------------------------------------------------- *
 * Fixtures
 * --------------------------------------------------------------------------------------------- */

const LINES: VoiceLineTable = {
  version: 1,
  personas: {
    hustler: { say: "Rocko (English (US))", rate: 215, pbas: 50, pmod: 45, web: { pitch: 1, rate: 1.15 } },
    narrator: { say: "Eddy (English (UK))", rate: 185, pbas: 45, pmod: 35, web: { pitch: 1, rate: 1 } },
    crone: { say: "Grandma (English (US))", rate: 170, pbas: 50, pmod: 40, web: { pitch: 1.1, rate: 0.9 } },
    snob: { say: "Albert", rate: 170, pbas: 40, pmod: 30, web: { pitch: 0.8, rate: 0.9 } },
    sheep: { say: "Bahh", rate: 180, pbas: 55, pmod: 40, web: { pitch: 1.5, rate: 1 } },
  },
  cards: {
    "core-004": { kind: "unit", persona: "hustler", play: "Double or nothing, baby!", death: "House always wins." },
    "core-005": { kind: "spell", persona: "narrator", cast: "Hoarding is self care." },
    "core-006": { kind: "spell", persona: "crone", cast: "Drink up, dearie." },
    "core-018": { kind: "trap", persona: "crone", cast: "Waste not, want toast." },
    "core-096": { kind: "trap", persona: "snob", cast: "Checkmate, puppet." },
    "core-t-sheep": { kind: "unit", persona: "sheep", play: "Baa?", death: "Baa..." },
  },
};

/** A unit (#4), a Spell (#5), a Field Spell (#6), a Field Trap (#18), a Trap (#96), a token. */
const UNIT = "core-004";
const SPELL = "core-005";
const FIELD_SPELL = "core-006";
const FIELD_TRAP = "core-018";
const TRAP = "core-096";
const TOKEN = "core-t-sheep";
const NOT_IN_TABLE = "core-999";

function ctx(over: Partial<CueContext> = {}): CueContext {
  return { view: baseView(), lines: LINES, manaBefore: () => 0, ...over };
}

/** A cue as one comparable string: "sfx:play@0", "voice:core-004/play@150". */
function said(cue: SoundCue): string {
  return cue.kind === "sfx" ? `sfx:${cue.id}@${String(cue.delayMs)}` : `voice:${cue.defId}/${cue.line}@${String(cue.delayMs)}`;
}

/** Every voice cue's line and priority, e.g. "core-004/death!2". */
function ranked(event: GameEvent, context: CueContext = ctx()): string[] {
  return cuesFor(event, context).flatMap((c) => (c.kind === "voice" ? [`${c.defId}/${c.line}!${String(c.priority)}`] : []));
}

/** The cues an event gives, order-free. */
function shape(event: GameEvent, context: CueContext = ctx()): string[] {
  return cuesFor(event, context).map(said).sort();
}

function voices(event: GameEvent, context: CueContext = ctx()): SoundCue[] {
  return cuesFor(event, context).filter((c) => c.kind === "voice");
}

function onlySfx(event: GameEvent, context: CueContext = ctx()): Extract<SoundCue, { kind: "sfx" }> {
  const cues = cuesFor(event, context);
  expect(cues, JSON.stringify(event)).toHaveLength(1);
  const [cue] = cues;
  if (cue === undefined || cue.kind !== "sfx") throw new Error(`expected one sfx cue for ${event.type}`);
  return cue;
}

const sfx = (id: SfxId, delayMs = 0): string => `sfx:${id}@${String(delayMs)}`;
const voice = (defId: string, line: string, delayMs: number): string => `voice:${defId}/${line}@${String(delayMs)}`;

const played = (defId: string, player: PlayerId = "p1", instanceId = "c1"): GameEvent => ({
  type: "cardPlayed",
  player,
  instanceId,
  defId,
  costPaid: 2,
});

const destroyed = (defId: string, owner: PlayerId = "p1", instanceId = "u1"): GameEvent => ({
  type: "destroyed",
  instanceId,
  defId,
  owner,
  attack: 3,
  maxHealth: 4,
  killerId: null,
});

const trapFired = (defId: string, controller: PlayerId = "p1"): GameEvent => ({
  type: "trapFired",
  instanceId: defId === HIDDEN_DEF_ID ? HIDDEN_DEF_ID : "b1",
  defId,
  controller,
  row: "backrow",
  lane: 3,
});

/** One event of every type, for the table-wide checks. */
const SAMPLES: { [K in GameEventType]: Extract<GameEvent, { type: K }> } = {
  cardPlayed: { type: "cardPlayed", player: "p1", instanceId: "c1", defId: UNIT, costPaid: 3 },
  cardResolved: { type: "cardResolved", player: "p1", instanceId: "c1", defId: UNIT, permanent: true, costPaid: 3 },
  summoned: { type: "summoned", player: "p1", instanceId: "c1", defId: UNIT, row: "units", lane: 2 },
  damage: { type: "damage", sourceId: "u1", targetId: "hero-p2", amount: 4, combat: true },
  healthLost: { type: "healthLost", player: "p1", amount: 3 },
  healed: { type: "healed", targetId: "hero-p1", amount: 2 },
  divineShieldLost: { type: "divineShieldLost", instanceId: "u6" },
  destroyed: { type: "destroyed", instanceId: "u1", defId: UNIT, owner: "p1", attack: 2, maxHealth: 3, killerId: "u6" },
  enteredGraveyard: { type: "enteredGraveyard", instanceId: "u1", defId: UNIT, owner: "p1" },
  exiled: { type: "exiled", instanceId: "u2", defId: UNIT, owner: "p1" },
  bounced: { type: "bounced", instanceId: "u3", defId: UNIT, owner: "p1" },
  burned: { type: "burned", instanceId: "cX", defId: SPELL, owner: "p2" },
  discarded: { type: "discarded", instanceId: "c11", defId: SPELL, owner: "p1" },
  drawn: { type: "drawn", player: "p1", instanceId: "cY", defId: UNIT },
  addedToHand: { type: "addedToHand", player: "p2", instanceId: "cZ", defId: UNIT },
  shuffledIn: { type: "shuffledIn", player: "p1", instanceId: "cW", defId: UNIT, position: 3 },
  buffed: { type: "buffed", instanceId: "u2", attack: 1, health: 1 },
  keywordGranted: { type: "keywordGranted", instanceId: "u2", keyword: { kind: "Taunt" } },
  counterChanged: { type: "counterChanged", instanceId: "u2", counter: "plague", value: 3 },
  costChanged: { type: "costChanged", instanceId: "c11", cost: 0 },
  modifierChanged: { type: "modifierChanged", player: "p2", modifierId: "m4", added: true },
  radiantSet: { type: "radiantSet", instanceId: "u3", defId: UNIT, zone: { z: "field", player: "p1", row: "units", lane: 2 } },
  transformed: { type: "transformed", instanceId: "u3", fromDefId: UNIT, toDefId: TOKEN, newInstanceId: "c90" },
  fused: { type: "fused", instanceIds: ["u1", "u2"], resultInstanceId: "c91", defId: UNIT },
  positionSwitched: { type: "positionSwitched", instanceId: "u3", position: "DEF" },
  controlChanged: { type: "controlChanged", instanceId: "u6", controller: "p1", row: "units", lane: 4 },
  rotated: { type: "rotated", direction: "left" },
  swapped: { type: "swapped", what: "health" },
  locked: { type: "locked", player: "p2", row: "backrow", lane: 1 },
  trapFired: { type: "trapFired", instanceId: "b5", defId: TRAP, controller: "p1", row: "backrow", lane: 3 },
  attackDeclared: { type: "attackDeclared", attackerId: "u1", targetId: "u6", forced: false },
  attackCancelled: { type: "attackCancelled", attackerId: "u1", targetId: "u6", byInstanceId: "b5" },
  manaChanged: { type: "manaChanged", player: "p1", current: 3, max: 4 },
  turnStarted: { type: "turnStarted", player: "p1", turn: 3 },
  turnEnded: { type: "turnEnded", player: "p1", turn: 3, unspentMana: 2 },
  turnAutoEnded: { type: "turnAutoEnded", player: "p1", turn: 3 },
  promptOpened: { type: "promptOpened", player: "p1", choiceId: "ch1", kind: "discover" },
  promptAnswered: { type: "promptAnswered", player: "p1", choiceId: "ch1" },
  drawOffered: { type: "drawOffered", player: "p2" },
  drawAnswered: { type: "drawAnswered", player: "p1", accept: false },
  gameOver: { type: "gameOver", winner: "p1", reason: "hero-death" },
};

/** The design's sfx column, row by row (null is an explicit silence). */
const HEADLINE: Record<GameEventType, SfxId | null> = {
  cardPlayed: "play",
  cardResolved: null,
  summoned: "summon",
  damage: "impact",
  healthLost: "drain",
  healed: "heal",
  divineShieldLost: "shieldShatter",
  destroyed: "death",
  enteredGraveyard: null,
  exiled: "poof",
  bounced: "whoosh",
  burned: "burn",
  discarded: "draw",
  drawn: "draw",
  addedToHand: "draw",
  shuffledIn: "whoosh",
  buffed: "buff",
  keywordGranted: "buff",
  counterChanged: "uiClick",
  costChanged: null,
  modifierChanged: "notify",
  radiantSet: "radiant",
  transformed: "poof",
  fused: "poof",
  positionSwitched: "whoosh",
  controlChanged: "whoosh",
  rotated: "whoosh",
  swapped: "whoosh",
  locked: "lock",
  trapFired: "trapSting",
  attackDeclared: "attack",
  attackCancelled: "cancel",
  manaChanged: "mana",
  turnStarted: "turnStart",
  turnEnded: null,
  turnAutoEnded: "notify",
  promptOpened: "notify",
  promptAnswered: null,
  drawOffered: "notify",
  drawAnswered: "cancel",
  gameOver: "victory",
};

/** Rows that return exactly their headline sound, whatever the payload (summoned: B56, below). */
const UNCONDITIONAL: readonly GameEventType[] = [
  "divineShieldLost",
  "exiled",
  "bounced",
  "burned",
  "discarded",
  "drawn",
  "addedToHand",
  "shuffledIn",
  "keywordGranted",
  "counterChanged",
  "radiantSet",
  "transformed",
  "fused",
  "positionSwitched",
  "controlChanged",
  "rotated",
  "swapped",
  "locked",
  "attackDeclared",
  "attackCancelled",
  "turnAutoEnded",
];

/* --------------------------------------------------------------------------------------------- *
 * B17: a total table
 * --------------------------------------------------------------------------------------------- */

describe("B17 SOUND_CUES is total over GameEvent types", () => {
  it("B17 has exactly one row per GAME_EVENT_TYPES member, and no other", () => {
    expect(Object.keys(SOUND_CUES).sort()).toEqual([...GAME_EVENT_TYPES].sort());
  });

  it("B17 every silent row says why, and only a silent row carries a reason", () => {
    const wrong: string[] = [];
    for (const type of GAME_EVENT_TYPES) {
      const row = SOUND_CUES[type];
      const reason = row.silentBecause;
      const hasReason = typeof reason === "string" && reason.trim().length > 0;
      if (row.sfx === null && !hasReason) wrong.push(`${type} is silent with no silentBecause`);
      if (row.sfx !== null && reason !== undefined) wrong.push(`${type} names ${row.sfx} and also a silentBecause`);
    }
    expect(wrong).toEqual([]);
  });

  it("B17 each row's headline sound is the design's", () => {
    const actual = Object.fromEntries(GAME_EVENT_TYPES.map((t) => [t, SOUND_CUES[t].sfx]));
    expect(actual).toEqual(HEADLINE);
  });

  it("B17 every headline, and every sfx a row returns for the samples, is an SfxId", () => {
    const ids = new Set<string>(SFX_IDS);
    const variants: GameEvent[] = [
      ...GAME_EVENT_TYPES.map((t) => SAMPLES[t]),
      played(SPELL),
      played(TRAP),
      played(HIDDEN_DEF_ID, "p2", HIDDEN_DEF_ID),
      destroyed(TOKEN),
      trapFired(HIDDEN_DEF_ID, "p2"),
      { type: "buffed", instanceId: "u2", attack: -3, health: 0 },
      { type: "gameOver", winner: "p2", reason: "concede" },
      { type: "gameOver", winner: "draw", reason: "draw-accepted" },
      { type: "turnStarted", player: "p2", turn: 4 },
      { type: "drawOffered", player: "p2" },
    ];
    const outside: string[] = [];
    for (const type of GAME_EVENT_TYPES) {
      const headline = SOUND_CUES[type].sfx;
      if (headline !== null && !ids.has(headline)) outside.push(`${type} headline ${headline}`);
    }
    for (const event of variants) {
      for (const cue of cuesFor(event, ctx())) {
        if (cue.kind === "sfx" && !ids.has(cue.id)) outside.push(`${event.type} → ${cue.id}`);
        if (cue.kind === "voice" && !["play", "death", "cast"].includes(cue.line)) outside.push(`${event.type} → line ${cue.line}`);
        if (!Number.isFinite(cue.delayMs) || cue.delayMs < 0) outside.push(`${event.type} → delay ${String(cue.delayMs)}`);
      }
    }
    expect(outside).toEqual([]);
  });

  it("B17 a silent row returns no cues", () => {
    for (const type of GAME_EVENT_TYPES.filter((t) => HEADLINE[t] === null)) {
      expect(cuesFor(SAMPLES[type], ctx()), type).toEqual([]);
    }
  });

  it("B17 each unconditional row returns exactly its headline sound, at delay 0", () => {
    for (const type of UNCONDITIONAL) {
      expect(shape(SAMPLES[type]), type).toEqual([sfx(HEADLINE[type] ?? "notify")]);
    }
  });

  it("B17 cuesFor answers through the event's own row", () => {
    for (const type of GAME_EVENT_TYPES) {
      const event = SAMPLES[type];
      const row = SOUND_CUES[type] as unknown as { cues: (e: GameEvent, c: CueContext) => readonly SoundCue[] };
      expect(cuesFor(event, ctx()).map(said), type).toEqual(row.cues(event, ctx()).map(said));
    }
  });

  it("B17 modifierChanged notifies when a modifier is added and stays silent when one is removed", () => {
    expect(shape({ type: "modifierChanged", player: "p1", modifierId: "m1", added: true })).toEqual([sfx("notify")]);
    expect(shape({ type: "modifierChanged", player: "p2", modifierId: "m1", added: false })).toEqual([]);
  });
});

/* --------------------------------------------------------------------------------------------- *
 * B18 and B19: which moments speak (R204)
 * --------------------------------------------------------------------------------------------- */

describe("R204: which moments speak", () => {
  it("R204 (B18) a readable unit's cardPlayed gives the play whoosh and its play line at VOICE_DELAY_MS", () => {
    expect(shape(played(UNIT))).toEqual([sfx("play"), voice(UNIT, "play", VOICE_DELAY_MS)].sort());
    expect(shape(played(TOKEN))).toEqual([sfx("play"), voice(TOKEN, "play", VOICE_DELAY_MS)].sort());
  });

  it("R204 (B18) the opponent's unit speaks its play line too: the card is public once played", () => {
    expect(shape(played(UNIT, "p2", "c7"))).toEqual([sfx("play"), voice(UNIT, "play", VOICE_DELAY_MS)].sort());
  });

  it("R204 (B18) a readable Spell's or Field Spell's cardPlayed gives play, spell at 60 ms and its cast line", () => {
    for (const defId of [SPELL, FIELD_SPELL]) {
      expect(shape(played(defId)), defId).toEqual([sfx("play"), sfx("spell", 60), voice(defId, "cast", VOICE_DELAY_MS)].sort());
    }
  });

  it("R204 (B18) a cardPlayed whose defId is not in the table gives play only", () => {
    expect(shape(played(NOT_IN_TABLE))).toEqual([sfx("play")]);
    expect(shape(played(NOT_IN_TABLE, "p2"))).toEqual([sfx("play")]);
  });

  it("R204 (B18) with an empty voice table nothing speaks, and a play still whooshes", () => {
    const empty: VoiceLineTable = { version: 1, personas: {}, cards: {} };
    expect(shape(played(UNIT), ctx({ lines: empty }))).toEqual([sfx("play")]);
    expect(shape(played(SPELL), ctx({ lines: empty }))).toEqual([sfx("play")]);
    expect(shape(destroyed(UNIT), ctx({ lines: empty }))).toEqual([sfx("death")]);
  });

  it("R204 (B19) a readable unit's destroyed gives death and its death line at DEATH_VOICE_DELAY_MS, tokens included", () => {
    expect(shape(destroyed(UNIT))).toEqual([sfx("death"), voice(UNIT, "death", DEATH_VOICE_DELAY_MS)].sort());
    expect(shape(destroyed(UNIT, "p2", "u8"))).toEqual([sfx("death"), voice(UNIT, "death", DEATH_VOICE_DELAY_MS)].sort());
    expect(shape(destroyed(TOKEN))).toEqual([sfx("death"), voice(TOKEN, "death", DEATH_VOICE_DELAY_MS)].sort());
  });

  it("R204 (B19) a destroyed Spell, Field Spell, Trap or Field Trap gives death only", () => {
    for (const defId of [SPELL, FIELD_SPELL, TRAP, FIELD_TRAP]) {
      expect(shape(destroyed(defId)), defId).toEqual([sfx("death")]);
    }
  });

  it("R204 (B19) a destroyed defId not in the table gives death only", () => {
    expect(shape(destroyed(NOT_IN_TABLE))).toEqual([sfx("death")]);
  });

  it("R204 (B19) bounced, exiled, transformed and fused are not deaths or plays, and never speak", () => {
    const events: GameEvent[] = [
      { type: "bounced", instanceId: "u1", defId: UNIT, owner: "p1" },
      { type: "exiled", instanceId: "u1", defId: UNIT, owner: "p2" },
      { type: "transformed", instanceId: "u1", fromDefId: UNIT, toDefId: TOKEN, newInstanceId: "u9" },
      { type: "fused", instanceIds: ["u1", "u2"], resultInstanceId: "u9", defId: UNIT },
    ];
    for (const event of events) expect(voices(event), event.type).toEqual([]);
    expect(events.map((e) => onlySfx(e).id)).toEqual(["whoosh", "poof", "poof", "poof"]);
  });

  it("R204 (B56) a unit summoned without a play (a token, a Recruit, a Reborn, a copy) speaks its play line at the lowest priority", () => {
    const token: GameEvent = { type: "summoned", player: "p2", instanceId: "t1", defId: TOKEN, row: "units", lane: 2 };
    const recruited: GameEvent = { type: "summoned", player: "p1", instanceId: "c1", defId: UNIT, row: "units", lane: 1 };
    expect(shape(token)).toEqual([sfx("summon"), voice(TOKEN, "play", VOICE_DELAY_MS)].sort());
    expect(ranked(token)).toEqual([`${TOKEN}/play!${String(VOICE_PRIORITY.summon)}`]);
    expect(ranked(recruited, ctx({ wasPlayed: () => false }))).toEqual([`${UNIT}/play!${String(VOICE_PRIORITY.summon)}`]);
  });

  it("R204 (B56) a unit whose own cardPlayed has sounded does not speak again when it lands", () => {
    const landed: GameEvent = { type: "summoned", player: "p1", instanceId: "c1", defId: UNIT, row: "units", lane: 1 };
    const context = ctx({ wasPlayed: (id) => id === "c1" });
    expect(voices(landed, context)).toEqual([]);
    expect(shape(landed, context)).toEqual([sfx("summon")]);
  });

  it("R204 (B56) a summoned Spell-table entry, the sentinel or an unknown id never speaks", () => {
    for (const defId of [SPELL, TRAP, HIDDEN_DEF_ID, NOT_IN_TABLE]) {
      const event: GameEvent = { type: "summoned", player: "p1", instanceId: "c5", defId, row: "units", lane: 1 };
      expect(voices(event), defId).toEqual([]);
    }
  });

  it("R204 (B56) every line carries its priority: play and cast lines on a play, death and trap lines react", () => {
    expect(ranked(played(UNIT))).toEqual([`${UNIT}/play!${String(VOICE_PRIORITY.play)}`]);
    expect(ranked(played(SPELL))).toEqual([`${SPELL}/cast!${String(VOICE_PRIORITY.play)}`]);
    expect(ranked(destroyed(UNIT))).toEqual([`${UNIT}/death!${String(VOICE_PRIORITY.react)}`]);
    expect(ranked(trapFired(TRAP))).toEqual([`${TRAP}/cast!${String(VOICE_PRIORITY.react)}`]);
    expect(VOICE_PRIORITY.react).toBeGreaterThan(VOICE_PRIORITY.play);
    expect(VOICE_PRIORITY.play).toBeGreaterThan(VOICE_PRIORITY.summon);
  });

  it("R204 (B19) a cardResolved never speaks a second time", () => {
    expect(cuesFor({ type: "cardResolved", player: "p1", instanceId: "c1", defId: UNIT, permanent: true, costPaid: 3 }, ctx())).toEqual([]);
    expect(cuesFor({ type: "cardResolved", player: "p1", instanceId: "c2", defId: SPELL, permanent: false, costPaid: 1 }, ctx())).toEqual([]);
  });
});

/* --------------------------------------------------------------------------------------------- *
 * B20: what audio may reveal (R203)
 * --------------------------------------------------------------------------------------------- */

describe("R203: audio reveals no more than the screen", () => {
  it("R203 (B20) HIDDEN_DEF_ID is the sentinel a redacted event carries", () => {
    expect(HIDDEN_DEF_ID).toBe("hidden");
  });

  it("R203 (B20) a cardPlayed whose defId is the sentinel plays the generic whoosh and never speaks", () => {
    const event = played(HIDDEN_DEF_ID, "p2", HIDDEN_DEF_ID);
    expect(voices(event)).toEqual([]);
    expect(shape(event)).toEqual([sfx("play")]);
  });

  it("R203 (B20) a destroyed whose defId is the sentinel plays death and never speaks", () => {
    const event = destroyed(HIDDEN_DEF_ID, "p2", HIDDEN_DEF_ID);
    expect(voices(event)).toEqual([]);
    expect(shape(event)).toEqual([sfx("death")]);
  });

  it("R203 (B20) setting the viewer's own Trap or Field Trap gives trapSet only, and never speaks", () => {
    expect(shape(played(TRAP))).toEqual([sfx("trapSet")]);
    expect(shape(played(FIELD_TRAP))).toEqual([sfx("trapSet")]);
  });

  it("R203 (B20) a trapFired with a readable defId gives the sting and its cast line on the controller's seat", () => {
    expect(shape(trapFired(TRAP))).toEqual([sfx("trapSting"), voice(TRAP, "cast", VOICE_DELAY_MS)].sort());
    expect(shape(trapFired(FIELD_TRAP))).toEqual([sfx("trapSting"), voice(FIELD_TRAP, "cast", VOICE_DELAY_MS)].sort());
  });

  it("R203 (B20) a trapFired carrying the sentinel gives the sting alone", () => {
    expect(shape(trapFired(HIDDEN_DEF_ID, "p2"))).toEqual([sfx("trapSting")]);
  });

  it("R203 (B20) the sentinel never speaks, even from a table that has an entry under that name", () => {
    const poisoned: VoiceLineTable = {
      ...LINES,
      cards: { ...LINES.cards, [HIDDEN_DEF_ID]: { kind: "unit", persona: "hustler", play: "Guess who.", death: "Guess who." } },
    };
    const context = ctx({ lines: poisoned });
    for (const event of [played(HIDDEN_DEF_ID, "p2", HIDDEN_DEF_ID), destroyed(HIDDEN_DEF_ID, "p2", HIDDEN_DEF_ID), trapFired(HIDDEN_DEF_ID, "p2")]) {
      expect(voices(event, context), event.type).toEqual([]);
    }
  });

  it("R203 (B20) the other seat hears a set trap as the generic play, with no line", () => {
    // p1 sets a trap; on p2's seat the event arrives redacted to the sentinel.
    const opponentSeat = ctx({ view: baseView({ viewer: "p2", you: emptySide("p2"), opponent: emptySide("p1") }) });
    const redacted = played(HIDDEN_DEF_ID, "p1", HIDDEN_DEF_ID);
    expect(voices(redacted, opponentSeat)).toEqual([]);
    expect(shape(redacted, opponentSeat)).toEqual([sfx("play")]);
  });
});

/* --------------------------------------------------------------------------------------------- *
 * B21: amounts
 * --------------------------------------------------------------------------------------------- */

describe("B21 amounts", () => {
  it("B21 damage, healed and healthLost with amount 0 give nothing", () => {
    expect(cuesFor({ type: "damage", sourceId: null, targetId: "u1", amount: 0, combat: false }, ctx())).toEqual([]);
    expect(cuesFor({ type: "healed", targetId: "hero-p1", amount: 0 }, ctx())).toEqual([]);
    expect(cuesFor({ type: "healthLost", player: "p1", amount: 0 }, ctx())).toEqual([]);
  });

  it("B21 a negative amount gives nothing either", () => {
    expect(cuesFor({ type: "damage", sourceId: null, targetId: "u1", amount: -2, combat: false }, ctx())).toEqual([]);
    expect(cuesFor({ type: "healed", targetId: "u1", amount: -1 }, ctx())).toEqual([]);
    expect(cuesFor({ type: "healthLost", player: "p2", amount: -5 }, ctx())).toEqual([]);
  });

  it("B21 damage n gives impact, healed n gives heal and healthLost n gives drain, each with params.amount n", () => {
    for (const n of [1, 7, 25]) {
      const hit = onlySfx({ type: "damage", sourceId: "u1", targetId: "u2", amount: n, combat: true });
      expect([hit.id, hit.params?.amount, hit.delayMs]).toEqual(["impact", n, 0]);
      const heal = onlySfx({ type: "healed", targetId: "hero-p2", amount: n });
      expect([heal.id, heal.params?.amount, heal.delayMs]).toEqual(["heal", n, 0]);
      const drain = onlySfx({ type: "healthLost", player: "p2", amount: n });
      expect([drain.id, drain.params?.amount, drain.delayMs]).toEqual(["drain", n, 0]);
    }
  });

  it("B21 buffed gives buff when attack + health is 0 or more", () => {
    for (const [attack, health] of [
      [1, 1],
      [0, 0],
      [2, -2],
      [-1, 3],
    ] as const) {
      expect(shape({ type: "buffed", instanceId: "u2", attack, health }), `${String(attack)}/${String(health)}`).toEqual([sfx("buff")]);
    }
  });

  it("B21 buffed gives debuff when attack + health is below 0", () => {
    for (const [attack, health] of [
      [-1, 0],
      [0, -1],
      [3, -4],
      [-2, -2],
    ] as const) {
      expect(shape({ type: "buffed", instanceId: "u2", attack, health }), `${String(attack)}/${String(health)}`).toEqual([sfx("debuff")]);
    }
  });
});

/* --------------------------------------------------------------------------------------------- *
 * B22: mana against a baseline
 * --------------------------------------------------------------------------------------------- */

describe("B22 manaChanged", () => {
  const before = (values: Partial<Record<PlayerId, number>>) => (player: PlayerId): number => values[player] ?? 0;

  it("B22 a gain above the baseline gives mana with the gain as amount, mine for the viewer", () => {
    const cue = onlySfx({ type: "manaChanged", player: "p1", current: 5, max: 5 }, ctx({ manaBefore: before({ p1: 3 }) }));
    expect(cue.id).toBe("mana");
    expect(cue.params?.amount).toBe(2);
    expect(cue.params?.mine).toBe(true);
    expect(cue.delayMs).toBe(0);
  });

  it("B22 the other seat's gain is not mine", () => {
    const cue = onlySfx({ type: "manaChanged", player: "p2", current: 4, max: 4 }, ctx({ manaBefore: before({ p2: 1 }) }));
    expect(cue.id).toBe("mana");
    expect(cue.params?.amount).toBe(3);
    expect(cue.params?.mine ?? false).toBe(false);
  });

  it("B22 mine follows the viewer, so the same gain is mine on p2's seat", () => {
    const p2Seat = ctx({ view: baseView({ viewer: "p2", you: emptySide("p2"), opponent: emptySide("p1") }), manaBefore: before({ p2: 0 }) });
    expect(onlySfx({ type: "manaChanged", player: "p2", current: 1, max: 1 }, p2Seat).params?.mine).toBe(true);
  });

  it("B22 a manaChanged at the baseline gives nothing", () => {
    expect(cuesFor({ type: "manaChanged", player: "p1", current: 3, max: 5 }, ctx({ manaBefore: before({ p1: 3 }) }))).toEqual([]);
  });

  it("B22 spending, a manaChanged below the baseline, gives nothing", () => {
    expect(cuesFor({ type: "manaChanged", player: "p1", current: 1, max: 5 }, ctx({ manaBefore: before({ p1: 4 }) }))).toEqual([]);
    expect(cuesFor({ type: "manaChanged", player: "p2", current: 0, max: 5 }, ctx({ manaBefore: before({ p2: 5 }) }))).toEqual([]);
  });

  it("B22 the baseline is read for the event's own player", () => {
    const context = ctx({ manaBefore: before({ p1: 9, p2: 0 }) });
    expect(shape({ type: "manaChanged", player: "p2", current: 2, max: 2 }, context)).toEqual([sfx("mana")]);
    expect(shape({ type: "manaChanged", player: "p1", current: 2, max: 2 }, context)).toEqual([]);
  });
});

/* --------------------------------------------------------------------------------------------- *
 * B23: seat-relative rows
 * --------------------------------------------------------------------------------------------- */

describe("B23 seat-relative rows", () => {
  const p2Seat = (): CueContext => ctx({ view: baseView({ viewer: "p2", you: emptySide("p2"), opponent: emptySide("p1") }) });

  it("B23 gameOver plays victory on the winner's seat", () => {
    expect(shape({ type: "gameOver", winner: "p1", reason: "hero-death" })).toEqual([sfx("victory")]);
    expect(shape({ type: "gameOver", winner: "p2", reason: "concede" }, p2Seat())).toEqual([sfx("victory")]);
  });

  it("B23 gameOver plays defeat on the other seat", () => {
    expect(shape({ type: "gameOver", winner: "p2", reason: "hero-death" })).toEqual([sfx("defeat")]);
    expect(shape({ type: "gameOver", winner: "p1", reason: "turn-cap" }, p2Seat())).toEqual([sfx("defeat")]);
  });

  it("B23 gameOver on a draw plays notify on both seats", () => {
    expect(shape({ type: "gameOver", winner: "draw", reason: "draw-accepted" })).toEqual([sfx("notify")]);
    expect(shape({ type: "gameOver", winner: "draw", reason: "both-heroes-dead" }, p2Seat())).toEqual([sfx("notify")]);
  });

  it("B23 promptOpened sounds only for the player holding the prompt", () => {
    expect(shape({ type: "promptOpened", player: "p1", choiceId: "ch1", kind: "target" })).toEqual([sfx("notify")]);
    expect(shape({ type: "promptOpened", player: "p2", choiceId: "ch2", kind: "target" })).toEqual([]);
    expect(shape({ type: "promptOpened", player: "p2", choiceId: "ch2", kind: "target" }, p2Seat())).toEqual([sfx("notify")]);
  });

  it("B23 drawOffered sounds only on the seat that must answer, never for the offerer", () => {
    expect(shape({ type: "drawOffered", player: "p2" })).toEqual([sfx("notify")]);
    expect(shape({ type: "drawOffered", player: "p1" })).toEqual([]);
    expect(shape({ type: "drawOffered", player: "p2" }, p2Seat())).toEqual([]);
  });

  it("drawOffered rings as a question (the urgent notify), not as the routine blips", () => {
    expect(onlySfx({ type: "drawOffered", player: "p2" }).params).toEqual({ urgent: true });
    expect(onlySfx({ type: "drawOffered", player: "p1" }, p2Seat()).params).toEqual({ urgent: true });
    // Every other notify stays the plain one.
    expect(onlySfx({ type: "turnAutoEnded", player: "p1", turn: 3 }).params).toBeUndefined();
    expect(onlySfx({ type: "promptOpened", player: "p1", choiceId: "ch1", kind: "target" }).params).toBeUndefined();
  });

  it("drawAnswered is the offerer's news: a decline sounds cancel, an acceptance leaves the draw to gameOver, and the answering seat hears nothing", () => {
    // p1 is the viewer. p2 answered p1's offer: p1 is the offerer.
    expect(shape({ type: "drawAnswered", player: "p2", accept: false })).toEqual([sfx("cancel")]);
    expect(shape({ type: "drawAnswered", player: "p2", accept: true })).toEqual([]);
    // p1 answered p2's offer: its own click already ticked.
    expect(shape({ type: "drawAnswered", player: "p1", accept: false })).toEqual([]);
    expect(shape({ type: "drawAnswered", player: "p1", accept: true })).toEqual([]);
    // The same from p2's seat.
    expect(shape({ type: "drawAnswered", player: "p1", accept: false }, p2Seat())).toEqual([sfx("cancel")]);
    expect(shape({ type: "drawAnswered", player: "p2", accept: false }, p2Seat())).toEqual([]);
  });

  it("B23 turnStarted carries mine for the viewer's own turn only", () => {
    const mine = onlySfx({ type: "turnStarted", player: "p1", turn: 5 });
    expect([mine.id, mine.params?.mine]).toEqual(["turnStart", true]);
    const theirs = onlySfx({ type: "turnStarted", player: "p2", turn: 6 });
    expect(theirs.id).toBe("turnStart");
    expect(theirs.params?.mine ?? false).toBe(false);
    expect(onlySfx({ type: "turnStarted", player: "p2", turn: 6 }, p2Seat()).params?.mine).toBe(true);
  });
});

/* --------------------------------------------------------------------------------------------- *
 * B56: a summon sounds its size
 * --------------------------------------------------------------------------------------------- */

describe("B56 a summon is sized by the unit that lands", () => {
  const landed: GameEvent = { type: "summoned", player: "p1", instanceId: "c1", defId: UNIT, row: "units", lane: 1 };
  const played1 = ctx({ wasPlayed: () => true });

  it("B56 the summon thud carries the unit's attack plus health, as the newest view shows it", () => {
    const big = unit("p1", { instanceId: "c1", defId: UNIT, attack: 7, health: 7, maxHealth: 7 });
    const cues = cuesFor(landed, { ...played1, unitNow: (id) => (id === "c1" ? big : null) });
    expect(cues).toEqual([{ kind: "sfx", id: "summon", params: { amount: 14 }, delayMs: 0 }]);
  });

  it("B56 a unit the view cannot find sounds the plain thud", () => {
    expect(cuesFor(landed, { ...played1, unitNow: () => null })).toEqual([{ kind: "sfx", id: "summon", delayMs: 0 }]);
    expect(cuesFor(landed, played1)).toEqual([{ kind: "sfx", id: "summon", delayMs: 0 }]);
  });

  it("B56 a Radiant unit lands with a golden glint on top of the thud", () => {
    const golden = unit("p1", { instanceId: "c1", defId: UNIT, attack: 2, health: 3, radiant: true });
    const ids = cuesFor(landed, { ...played1, unitNow: () => golden }).map((c) => (c.kind === "sfx" ? c.id : c.kind));
    expect(ids).toEqual(["summon", "radiant"]);
  });
});

/* --------------------------------------------------------------------------------------------- *
 * Integration: the public catalog colours a card the viewer can name (docs/polish/reference.md,
 * audio x cards), and R203 still bounds it.
 * --------------------------------------------------------------------------------------------- */

describe("the catalog colours summons and spells, never what the viewer cannot name", () => {
  const CATALOG: Record<string, CueCard> = {
    [UNIT]: { type: "Unit", tags: ["Felinor"], rarity: "Common" },
    [SPELL]: { type: "Spell", tags: ["Call to Chaos"], rarity: "Rare" },
    [FIELD_SPELL]: { type: "Field Spell", tags: [], rarity: "Epic" },
    [TRAP]: { type: "Trap", tags: ["KY"], rarity: "Rare" },
    "core-legend": { type: "Unit", tags: ["Human"], rarity: "Legendary" },
    "core-mythic": { type: "Unit", tags: [], rarity: "Mythic" },
  };
  const withCatalog = (over: Partial<CueContext> = {}): CueContext =>
    ctx({ card: (defId) => CATALOG[defId], ...over });
  const summoned = (defId: string, row: "units" | "backrow" = "units"): GameEvent => ({
    type: "summoned",
    player: "p1",
    instanceId: "c1",
    defId,
    row,
    lane: 1,
  });
  const sfxCue = (cues: readonly SoundCue[], id: SfxId): Extract<SoundCue, { kind: "sfx" }> | undefined =>
    cues.find((cue): cue is Extract<SoundCue, { kind: "sfx" }> => cue.kind === "sfx" && cue.id === id);

  it("timbreFor follows the card art's theme: tags first, then Token, then a Field Spell's type", () => {
    expect(timbreFor({ type: "Unit", tags: ["Human", "Felinor"] })).toBe("felinor");
    expect(timbreFor({ type: "Spell", tags: ["Call to Chaos", "KY"] })).toBe("chaos");
    expect(timbreFor({ type: "Unit", tags: ["Token"] })).toBe("token");
    expect(timbreFor({ type: "Field Spell", tags: [] })).toBe("field");
    expect(timbreFor({ type: "Unit", tags: [] })).toBeUndefined();
    expect(timbreFor({ type: "Spell", tags: [] })).toBeUndefined();
  });

  it("a unit the viewer can name lands with its family's accent on the thud", () => {
    const cue = sfxCue(cuesFor(summoned(UNIT), withCatalog()), "summon");
    expect(cue?.params?.timbre).toBe("felinor");
  });

  it("a Legendary unit enters with the brass sting, a Mythic one with the prismatic sting, at the thud", () => {
    const legend = cuesFor(summoned("core-legend"), withCatalog());
    expect(sfxCue(legend, "entrance")).toEqual({ kind: "sfx", id: "entrance", delayMs: 0 });
    expect(sfxCue(legend, "summon")?.params?.timbre).toBe("human");

    const mythic = cuesFor(summoned("core-mythic"), withCatalog());
    expect(sfxCue(mythic, "entrance")).toEqual({ kind: "sfx", id: "entrance", params: { mythic: true }, delayMs: 0 });
    expect(sfxCue(cuesFor(summoned(UNIT), withCatalog()), "entrance")).toBeUndefined();
  });

  it("a cast spell rings in its family's chimes, a Field Spell in the field's", () => {
    expect(sfxCue(cuesFor(played(SPELL), withCatalog()), "spell")?.params).toEqual({ timbre: "chaos" });
    expect(sfxCue(cuesFor(played(FIELD_SPELL), withCatalog()), "spell")?.params).toEqual({ timbre: "field" });
  });

  it("with no catalog every card keeps its type's plain sounds", () => {
    expect(sfxCue(cuesFor(summoned("core-legend"), ctx()), "entrance")).toBeUndefined();
    expect(sfxCue(cuesFor(summoned(UNIT), ctx()), "summon")?.params).toBeUndefined();
    expect(sfxCue(cuesFor(played(SPELL), ctx()), "spell")?.params).toBeUndefined();
  });

  it("R203 a card behind the sentinel is never looked up: no accent, no sting, the generic sound", () => {
    const asked: string[] = [];
    const context = withCatalog({
      card: (defId) => {
        asked.push(defId);
        return CATALOG["core-mythic"];
      },
    });
    const cues = cuesFor(summoned(HIDDEN_DEF_ID), context);
    expect(sfxCue(cues, "entrance")).toBeUndefined();
    expect(sfxCue(cues, "summon")?.params?.timbre).toBeUndefined();
    expect(shape(played(HIDDEN_DEF_ID), context)).toEqual([sfx("play")]);
    expect(asked).toEqual([]);
  });

  it("R203 a Trap sounds like every Trap: its set and its backrow arrival take no family", () => {
    expect(shape(played(TRAP), withCatalog())).toEqual([sfx("trapSet")]);
    const arrival = sfxCue(cuesFor(summoned(TRAP, "backrow"), withCatalog()), "summon");
    expect(arrival?.params?.timbre).toBeUndefined();
    expect(sfxCue(cuesFor(summoned("core-mythic", "backrow"), withCatalog()), "entrance")).toBeUndefined();
  });
});
