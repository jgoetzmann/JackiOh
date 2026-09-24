// What the cue planner remembers across the entries of one FxLayer mount (docs/polish/1-animations.md
// S6): who played which card, and which zone a trap fired from. A spell's `damage` names only its
// `sourceId`, and by the time it lands the spell may be rendered nowhere, so the planner falls back to
// the zone the trap flipped in or the hero of the player who cast it.
//
// R202: only ids the viewer may read are kept. An event redacted to the "hidden" sentinel is ignored,
// so every hidden card looks the same to the planner whatever it hides.
//
// Each map keeps at most `limit` entries in insertion order. Remembering an id again refreshes it, and
// the oldest entry is evicted first once the map is full.

import type { GameEvent, PlayerId } from "@jackioh/shared";

import { FX_MEMORY_LIMIT } from "./constants.ts";
import type { FxMemory, FxTrapZone } from "./types.ts";

const HIDDEN_ID = "hidden";

function put<V>(map: Map<string, V>, key: string, value: V, limit: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done === true) return;
    map.delete(oldest.value);
  }
}

export function createFxMemory(limit: number = FX_MEMORY_LIMIT): FxMemory {
  const casters = new Map<string, PlayerId>();
  const traps = new Map<string, FxTrapZone>();

  return {
    remember(events: readonly GameEvent[]): void {
      for (const event of events) {
        if (event.type === "cardPlayed") {
          if (event.instanceId !== HIDDEN_ID) put(casters, event.instanceId, event.player, limit);
        } else if (event.type === "trapFired") {
          if (event.instanceId !== HIDDEN_ID) {
            put(traps, event.instanceId, { player: event.controller, row: event.row, lane: event.lane }, limit);
          }
        }
      }
    },
    casterOf(instanceId: string): PlayerId | undefined {
      return casters.get(instanceId);
    },
    trapZoneOf(instanceId: string): FxTrapZone | undefined {
      const zone = traps.get(instanceId);
      return zone === undefined ? undefined : { player: zone.player, row: zone.row, lane: zone.lane };
    },
    clear(): void {
      casters.clear();
      traps.clear();
    },
  };
}
