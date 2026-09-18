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

/** The face that is running: radiant text once the instance is Radiant (§5.2). */
export function scriptOf(instance: CardInstance): Script {
  const entry = scriptsFor(instance.defId);
  return instance.radiant ? entry.radiant : entry.base;
}

export function flagsOf(instance: CardInstance): NonNullable<Script["staticFlags"]> {
  return scriptOf(instance).staticFlags ?? {};
}
