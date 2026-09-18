// Player modifiers and delayed effects, with their expiry (SPEC §2.2, §10.1, R62, R68).

import type { DistributiveOmit, PlayerId } from "@jackioh/shared";
import { PLAYER_IDS } from "@jackioh/shared";
import type { DelayedEffect, GameState, PlayerModifier, Resume } from "./state";
import type { EngineSink } from "./resolve";

export function addModifier(
  sink: EngineSink,
  player: PlayerId,
  mod: DistributiveOmit<PlayerModifier, "id">,
): PlayerModifier {
  const withId = { ...mod, id: `m${sink.state.nextSeq}` } as PlayerModifier;
  sink.state.nextSeq += 1;
  sink.state.players[player].mods.push(withId);
  sink.events.push({ type: "modifierChanged", player, modifierId: withId.id, added: true });
  return withId;
}

export function removeModifier(sink: EngineSink, player: PlayerId, id: string): void {
  const side = sink.state.players[player];
  const before = side.mods.length;
  side.mods = side.mods.filter((mod) => mod.id !== id);
  if (side.mods.length !== before) {
    sink.events.push({ type: "modifierChanged", player, modifierId: id, added: false });
  }
}

/** An "until used" modifier is consumed the moment it applies (Lunar Eclipse's discount). */
export function consumeModifier(sink: EngineSink, player: PlayerId, id: string): void {
  removeModifier(sink, player, id);
}

/**
 * Cleanup at the end of `player`'s turn: "this turn" modifiers go, and so do the ones that were
 * scheduled to last through this player's turn (Professor Curvature, R48).
 */
export function expireModifiers(sink: EngineSink, player: PlayerId): void {
  for (const side of PLAYER_IDS) {
    const state = sink.state.players[side];
    const kept = state.mods.filter((mod) => {
      if (mod.expiry.until === "thisTurn") return mod.expiry.turn !== sink.state.turn;
      // R48: it covers that player's *next* turn, so it survives the turn it was created on.
      if (mod.expiry.until === "nextTurnOf") {
        return !(mod.expiry.player === player && sink.state.turn > mod.expiry.fromTurn);
      }
      return true;
    });
    for (const mod of state.mods) {
      if (!kept.includes(mod)) {
        sink.events.push({ type: "modifierChanged", player: side, modifierId: mod.id, added: false });
      }
    }
    state.mods = kept;
  }
}

export function scheduleDelayed(
  sink: EngineSink,
  owner: PlayerId,
  at: DelayedEffect["at"],
  resume: Resume,
): DelayedEffect {
  const effect: DelayedEffect = { id: `d${sink.state.nextSeq}`, seq: sink.state.nextSeq, owner, at, resume };
  sink.state.nextSeq += 1;
  sink.state.delayed.push(effect);
  return effect;
}

/** R68: delayed effects due now, in the order they were created. */
export function dueDelayed(state: GameState, phase: "start" | "end", player: PlayerId): DelayedEffect[] {
  return state.delayed
    .filter((effect) => effect.at.phase === phase && effect.at.player === player)
    .sort((a, b) => a.seq - b.seq);
}

export function dropDelayed(state: GameState, id: string): void {
  state.delayed = state.delayed.filter((effect) => effect.id !== id);
}
