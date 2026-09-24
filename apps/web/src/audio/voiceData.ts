// Voice line data access (docs/polish/2-sound.md, "voiceData.ts").
//
// `voice-lines.json` (the lines and personas) and `voice-manifest.json` (which rendered files exist,
// written by `apps/web/scripts/gen-voice.mjs`) are imported here and nowhere else. The lines are
// validated once at import, so a malformed table fails loudly at load instead of speaking garbage.
// Everything here reads a `PlayerView` or a defId and nothing else (CLAUDE.md rule 7, R203): a
// redacted card carries `HIDDEN_DEF_ID`, which is never in the table, so it never yields a line.

import type { PlayerView } from "@jackioh/shared";

import { HIDDEN_DEF_ID } from "./constants.ts";
import type {
  Persona,
  VoiceKey,
  VoiceLineEntry,
  VoiceLineKind,
  VoiceLineTable,
  VoiceManifest,
} from "./types.ts";
import rawLines from "./voice-lines.json";
import rawManifest from "./voice-manifest.json";

/* ------------------------------------------------------------------------------------------- *
 * Parsing
 * ------------------------------------------------------------------------------------------- */

function fail(path: string, problem: string): never {
  throw new Error(`voice-lines.json: ${path}: ${problem}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) fail(path, "must be an object");
  return value;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(path, "must be a non-empty string");
  return value;
}

function numberIn(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    fail(path, `must be a number from ${min} to ${max}`);
  }
  return value;
}

const RATE_RANGE = [90, 360] as const;
const PITCH_BASE_RANGE = [0, 127] as const;
const PITCH_MOD_RANGE = [0, 127] as const;
const WEB_PITCH_RANGE = [0, 2] as const;
const WEB_RATE_RANGE = [0.1, 10] as const;
const GAIN_RANGE = [0, 2] as const;

function parsePersona(raw: unknown, path: string): Persona {
  const o = record(raw, path);
  const web = record(o.web, `${path}.web`);
  const persona: Persona = {
    say: text(o.say, `${path}.say`),
    rate: numberIn(o.rate, `${path}.rate`, ...RATE_RANGE),
    pbas: numberIn(o.pbas, `${path}.pbas`, ...PITCH_BASE_RANGE),
    pmod: numberIn(o.pmod, `${path}.pmod`, ...PITCH_MOD_RANGE),
    web: {
      pitch: numberIn(web.pitch, `${path}.web.pitch`, ...WEB_PITCH_RANGE),
      rate: numberIn(web.rate, `${path}.web.rate`, ...WEB_RATE_RANGE),
    },
  };
  if (o.gain !== undefined) persona.gain = numberIn(o.gain, `${path}.gain`, ...GAIN_RANGE);
  return persona;
}

function parseEntry(raw: unknown, path: string, personas: Record<string, Persona>): VoiceLineEntry {
  const o = record(raw, path);
  const persona = text(o.persona, `${path}.persona`);
  if (!Object.hasOwn(personas, persona)) fail(`${path}.persona`, `unknown persona "${persona}"`);
  const overrides: { rate?: number; pbas?: number; pmod?: number } = {};
  if (o.rate !== undefined) overrides.rate = numberIn(o.rate, `${path}.rate`, ...RATE_RANGE);
  if (o.pbas !== undefined) overrides.pbas = numberIn(o.pbas, `${path}.pbas`, ...PITCH_BASE_RANGE);
  if (o.pmod !== undefined) overrides.pmod = numberIn(o.pmod, `${path}.pmod`, ...PITCH_MOD_RANGE);
  const kind = o.kind;
  if (kind === "unit") {
    if (o.cast !== undefined) fail(`${path}.cast`, "a unit has play and death lines, not a cast line");
    return {
      kind,
      persona,
      play: text(o.play, `${path}.play`),
      death: text(o.death, `${path}.death`),
      ...overrides,
    };
  }
  if (kind === "spell" || kind === "trap") {
    if (o.play !== undefined) fail(`${path}.play`, `a ${kind} has a cast line, not a play line`);
    if (o.death !== undefined) fail(`${path}.death`, `a ${kind} has a cast line, not a death line`);
    return { kind, persona, cast: text(o.cast, `${path}.cast`), ...overrides };
  }
  return fail(`${path}.kind`, 'must be "unit", "spell" or "trap"');
}

/** Throws Error("voice-lines.json: <path>: <problem>") on a shape error. Does NOT check word limits (tests do). */
export function parseVoiceLines(raw: unknown): VoiceLineTable {
  const root = record(raw, "(root)");
  if (root.version !== 1) fail("version", "must be 1");
  const rawPersonas = record(root.personas, "personas");
  const personas: Record<string, Persona> = {};
  for (const [id, value] of Object.entries(rawPersonas)) {
    personas[id] = parsePersona(value, `personas.${id}`);
  }
  const rawCards = record(root.cards, "cards");
  const cards: Record<string, VoiceLineEntry> = {};
  for (const [defId, value] of Object.entries(rawCards)) {
    if (defId === HIDDEN_DEF_ID) fail(`cards.${defId}`, "the hidden sentinel cannot have lines");
    cards[defId] = parseEntry(value, `cards.${defId}`, personas);
  }
  return { version: 1, personas, cards };
}

export const VOICE_LINES: VoiceLineTable = parseVoiceLines(rawLines);
/** Generated by gen-voice.mjs and checked against the files by its `--check` (B35, B37). */
export const VOICE_MANIFEST = rawManifest as VoiceManifest;

/* ------------------------------------------------------------------------------------------- *
 * Lookups
 * ------------------------------------------------------------------------------------------- */

export function voiceKey(defId: string, line: VoiceLineKind): VoiceKey {
  return `${defId}-${line}`;
}

export function voiceUrl(key: VoiceKey): string {
  return `${import.meta.env.BASE_URL}audio/voice/${key}.m4a`;
}

/**
 * The table entry for a card this viewer may name, or null. This is R203's "readable": the defId is
 * not the redaction sentinel (R97, R154) and the table has an entry for it (a fused transient
 * definition, R77, has none).
 */
export function entryFor(lines: VoiceLineTable, defId: string): VoiceLineEntry | null {
  if (defId === HIDDEN_DEF_ID || !Object.hasOwn(lines.cards, defId)) return null;
  return lines.cards[defId] ?? null;
}

/** The text and effective persona (per-card rate/pbas/pmod overrides applied) or null. */
export function lineFor(
  lines: VoiceLineTable,
  defId: string,
  line: VoiceLineKind,
): { text: string; persona: Persona } | null {
  const entry = entryFor(lines, defId);
  if (entry === null) return null;
  let spoken: string | null = null;
  if (entry.kind === "unit") {
    if (line === "play") spoken = entry.play;
    else if (line === "death") spoken = entry.death;
  } else if (line === "cast") {
    spoken = entry.cast;
  }
  if (spoken === null) return null;
  const base = lines.personas[entry.persona];
  if (base === undefined) return null;
  const persona: Persona = {
    ...base,
    rate: entry.rate ?? base.rate,
    pbas: entry.pbas ?? base.pbas,
    pmod: entry.pmod ?? base.pmod,
  };
  return { text: spoken, persona };
}

/** Keys worth preloading for a view, deduped, in this order: the viewer's hand (unit → play, spell → cast;
 *  traps none), every unit on both boards (death), the viewer's own face-up backrow traps (cast). */
export function voiceKeysForView(view: PlayerView, lines: VoiceLineTable): VoiceKey[] {
  const keys: VoiceKey[] = [];
  const seen = new Set<string>();
  const add = (key: VoiceKey): void => {
    if (seen.has(key)) return;
    seen.add(key);
    keys.push(key);
  };

  const hand = view.you.hand;
  if (Array.isArray(hand)) {
    for (const card of hand) {
      const entry = entryFor(lines, card.defId);
      if (entry?.kind === "unit") add(voiceKey(card.defId, "play"));
      else if (entry?.kind === "spell") add(voiceKey(card.defId, "cast"));
    }
  }

  for (const side of [view.you, view.opponent]) {
    for (const u of side.units) {
      if (u === null) continue;
      if (entryFor(lines, u.defId)?.kind === "unit") add(voiceKey(u.defId, "death"));
    }
  }

  for (const side of [view.you, view.opponent]) {
    for (const slot of side.backrow) {
      if (slot === null || slot.faceDown) continue;
      if (slot.controller !== view.viewer) continue;
      if (entryFor(lines, slot.defId)?.kind === "trap") add(voiceKey(slot.defId, "cast"));
    }
  }

  return keys;
}
