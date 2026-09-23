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
