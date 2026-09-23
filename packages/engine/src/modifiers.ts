// Player modifiers and delayed effects, with their expiry (SPEC §2.2, §10.1, R62, R68).

import type { DistributiveOmit, PlayerId } from "@jackioh/shared";
import { PLAYER_IDS } from "@jackioh/shared";
import { findInstance, type DelayedEffect, type GameState, type PlayerModifier, type Resume } from "./state";
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

/**
 * The modifiers a permanent installed and still owns (`sourceId`, #79 Twinspell) move with it when
 * its controller changes (§5.1, §8 conventions: "your" is the controller). Each keeps its id, and
 * the move is reported as the removal from one seat and the addition to the other, which is what
 * R169's badges on both seats read.
 */
export function moveSourcedModifiers(sink: EngineSink, sourceId: string, from: PlayerId, to: PlayerId): void {
  if (from === to) return;
  const side = sink.state.players[from];
  const moving = side.mods.filter((mod) => "sourceId" in mod && mod.sourceId === sourceId);
  if (moving.length === 0) return;
  side.mods = side.mods.filter((mod) => !moving.includes(mod));
  for (const mod of moving) {
    sink.events.push({ type: "modifierChanged", player: from, modifierId: mod.id, added: false });
    sink.state.players[to].mods.push(mod);
    sink.events.push({ type: "modifierChanged", player: to, modifierId: mod.id, added: true });
  }
}

/**
 * R209: a modifier a permanent installed and still owns (`sourceId`, #79 Twinspell's "the next
 * Spell you play gains Echo") is that permanent's lasting effect (§5.1), so it lasts while the
 * permanent stays on the field and ends when it leaves — destroyed (#36, #88), bounced (#52's
 * radiant crossing, a Locked rotation or swap), exiled (#34, #100), eaten (#22), replaced (#83) or
 * fused away (#85). A card that later stands on the field under the same id is a new arrival that
 * installs its own (R174). The state check runs this, since it follows every action and every whole
 * effect (§4.5, R59), and each removal is reported like any other (R169).
 */
export function endOrphanedModifiers(sink: EngineSink): void {
  for (const player of PLAYER_IDS) {
    for (const mod of [...sink.state.players[player].mods]) {
      if (!("sourceId" in mod) || mod.sourceId === undefined) continue;
      const source = findInstance(sink.state, mod.sourceId);
      if (source !== undefined && source.zone.z === "field") continue;
      removeModifier(sink, player, mod.id);
    }
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
  watch?: string,
): DelayedEffect {
  const effect: DelayedEffect = {
    id: `d${sink.state.nextSeq}`,
    seq: sink.state.nextSeq,
    owner,
    at,
    resume,
    ...(watch === undefined ? {} : { watch }),
  };
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
