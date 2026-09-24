// Player modifiers and delayed effects, with their expiry (SPEC §2.2, §10.1, R62, R68).

import type { DistributiveOmit, PlayerId } from "@jackioh/shared";
import { PLAYER_IDS } from "@jackioh/shared";
import { findInstance, type DelayedEffect, type GameState, type PlayerModifier, type Resume } from "./state";
import type { EngineSink } from "./resolve";
import { flagsOf } from "./scripts";
import { cardAt, slotsOf } from "./zones";

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

/**
 * R209, R169: a permanent's lasting effect is installed by the permanent standing on the field, not
 * by its Cry — #79 Twinspell's "the next Spell you play gains Echo +1" prints no "Cry:" (§8), and a
 * Cry fires only for a card played from hand (§6.2). So every permanent that stands on a side of the
 * field with a `staticFlags.echoGrant` has one `echoNextSpell` rider on that side's player, owned by
 * it (`sourceId`), however it got there: played, summoned (#22's copies, #95's backrow, #98's
 * recruit), or holding Twinspell's text through a Fuse onto another permanent (#85, R77), in which
 * case "you" is that permanent's controller (§8 Conventions). The state check runs this beside
 * `endOrphanedModifiers`, which ends the rider when the permanent leaves, and `echo.grantedEcho`
 * runs it once more before a Spell takes the grant, so a permanent that arrived since the last check
 * is not missed. A rider that already exists is left alone, so a card that stays on the field keeps
 * the id its badge was given (R169); one that changed sides has had its rider moved with it
 * (`moveSourcedModifiers`), and the one it finds on its new controller's side is that same rider.
 */
export function installLastingModifiers(sink: EngineSink): void {
  for (const player of PLAYER_IDS) {
    for (const row of ["units", "backrow"] as const) {
      for (const ref of slotsOf(player, row)) {
        const card = cardAt(sink.state, ref);
        if (card === null) continue;
        const amount = Math.max(0, Math.trunc(flagsOf(card).echoGrant ?? 0));
        if (amount <= 0) continue;
        const owned = sink.state.players[player].mods.some(
          (mod) => mod.kind === "echoNextSpell" && mod.sourceId === card.id,
        );
        if (owned) continue;
        addModifier(sink, player, {
          kind: "echoNextSpell",
          amount,
          sourceId: card.id,
          // §2.2: not turn-scoped — it survives cleanup and waits for a Spell (R30).
          expiry: { until: "used" },
        });
      }
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
      // §2.2: a "this turn" effect lasts to the end of its turn. One made after its turn's cleanup
      // had run — a trigger answering cleanup's own events, which resolve inside that turn (R62) — is
      // over by the next cleanup, whoever's it is, and dead from the next turn on (`modifierIsLive`).
      if (mod.expiry.until === "thisTurn") return mod.expiry.turn > sink.state.turn;
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
