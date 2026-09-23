// Script registry: `packages/cards` registers one entry per catalog id (M4-T2), and engine tests
// register fixtures (BUILD §0). Like the catalog this is static data, not game state.

import type { CardInstance } from "./state";
import { EMPTY_SCRIPT, type CardScripts, type Script } from "./script";

let registered: Readonly<Record<string, CardScripts>> = {};

export function registerScripts(scripts: Readonly<Record<string, CardScripts>>): void {
  registered = scripts;
}

export function registeredScripts(): Readonly<Record<string, CardScripts>> {
  return registered;
}

export function scriptsFor(defId: string): CardScripts {
  return registered[defId] ?? { base: EMPTY_SCRIPT, radiant: EMPTY_SCRIPT };
}

/**
 * The face that is running: radiant text once the instance is Radiant (§5.2).
 *
 * A Vanilla instance runs no script at all: §6.3's Vanilla "clears printed keywords and scripts"
 * and R115 says so of every hook, so its triggers, its start- and end-of-turn hooks, its Death and
 * its static flags (Deft Duelist's two exertions, Spikey Pillow's "cannot be in Defense Position")
 * are gone with its text. This is the one place a card's script is read off an instance, so the
 * guard lives here rather than in each reader; a continuation parked before the Vanilla landed is
 * re-entered by its stored def id (`prompts.runResume`), never through here, so it still finishes.
 */
export function scriptOf(instance: CardInstance): Script {
  if (instance.vanilla === true) return EMPTY_SCRIPT;
  const entry = scriptsFor(instance.defId);
  return instance.radiant ? entry.radiant : entry.base;
}

export function flagsOf(instance: CardInstance): NonNullable<Script["staticFlags"]> {
  return scriptOf(instance).staticFlags ?? {};
}

/**
 * R77, R102: where a card a Fuse kept on the field remembers the price each ingredient was played
 * for (§6.3 Embiggen, R65), in the order of the fused definition's ingredients, when they are not
 * all the kept card's own. The fused card carries every ingredient's text, and a text that reads its
 * own price (#46's "paid 4: −5/−5", #84's "paid 4: 5", #59's "paid 4: it costs 0") reads the one its
 * card was played for, not the kept instance's. An ingredient that was itself a fused card with such
 * a record keeps it as its `parts`. Absent when every ingredient was played at the kept card's price,
 * which is then every text's (so R77's "every other field unchanged" holds whenever it can). Memory,
 * so R78 resets it with everything else a card leaves the field without: a fused card replayed from
 * a hand paid the fused cost, and no ingredient's embiggen price.
 */
export const INGREDIENTS_KEY = "__ingredients";

/** One ingredient of a fused card, as `INGREDIENTS_KEY` records it. */
export type IngredientRecord = { defId: string; embiggened: boolean; parts?: IngredientRecord[] };

function recordsFrom(raw: unknown): IngredientRecord[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.flatMap((entry: unknown): IngredientRecord[] => {
    if (entry === null || typeof entry !== "object") return [];
    const record = entry as { defId?: unknown; embiggened?: unknown; parts?: unknown };
    if (typeof record.defId !== "string") return [];
    const parts = recordsFrom(record.parts);
    return [{ defId: record.defId, embiggened: record.embiggened === true, ...(parts === null ? {} : { parts }) }];
  });
}

/** The ingredient prices a kept fused card records, or null when it records none (it came through JSON). */
export function ingredientsOf(instance: Pick<CardInstance, "memory">): IngredientRecord[] | null {
  return recordsFrom(instance.memory[INGREDIENTS_KEY]);
}

/**
 * R102: the price the text at `path` was played for — `path` is the text's place in the fusion, one
 * index per level (`work.PART_KEY`'s path), and a card that records no prices has one, its own.
 */
export function ingredientPaid(instance: CardInstance, path: readonly number[]): boolean {
  let records = ingredientsOf(instance);
  let paid = instance.embiggened === true;
  for (const index of path) {
    const record = records?.[index];
    if (record === undefined) return paid;
    paid = record.embiggened;
    records = record.parts ?? null;
  }
  return paid;
}

/**
 * R102: the card as the text of ingredient `index` reads it — at that ingredient's price, carrying
 * that ingredient's own record — for a hook that reads "this" rather than a context (§10.4's aura).
 * The same instance when the card records no prices.
 */
export function asIngredient(instance: CardInstance, index: number): CardInstance {
  const record = ingredientsOf(instance)?.[index];
  if (record === undefined) return instance;
  const memory = { ...instance.memory };
  if (record.parts === undefined) delete memory[INGREDIENTS_KEY];
  else memory[INGREDIENTS_KEY] = record.parts;
  return { ...instance, embiggened: record.embiggened, memory };
}

/** What a Fuse records for the card it keeps (`INGREDIENTS_KEY`), or null when it records nothing. */
export function ingredientRecord(kept: CardInstance, ingredients: readonly CardInstance[]): IngredientRecord[] | null {
  const own = kept.embiggened === true;
  const records = ingredients.map((card): IngredientRecord => {
    const parts = ingredientsOf(card);
    return { defId: card.defId, embiggened: card.embiggened === true, ...(parts === null ? {} : { parts }) };
  });
  return records.every((record) => record.embiggened === own && record.parts === undefined) ? null : records;
}

/**
 * Every text a card carries with its own static flags and the price it was played for: one for a
 * card that records no prices (a fused card's summed flags among them, all at its one price), one
 * per ingredient for one that does (R102). A Vanilla card carries none (§6.3, R115).
 */
export function textsOf(instance: CardInstance): { flags: NonNullable<Script["staticFlags"]>; embiggened: boolean }[] {
  if (instance.vanilla === true) return [];
  const records = ingredientsOf(instance);
  if (records === null) return [{ flags: flagsOf(instance), embiggened: instance.embiggened === true }];
  const walk = (list: readonly IngredientRecord[]): { flags: NonNullable<Script["staticFlags"]>; embiggened: boolean }[] =>
    list.flatMap((record) => {
      if (record.parts !== undefined) return walk(record.parts);
      const entry = scriptsFor(record.defId);
      const face = instance.radiant ? entry.radiant : entry.base;
      return [{ flags: face.staticFlags ?? {}, embiggened: record.embiggened }];
    });
  return walk(records);
}
