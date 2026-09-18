// Drawing, fatigue, the hand cap, cast-on-draw chains and the library cap
// (SPEC §2.4, R3, R4, R58, R80).

import type { PlayerId } from "@jackioh/shared";
import { CAST_ON_DRAW_CHAIN_CAP, FATIGUE_DAMAGE, HAND_CAP, LIBRARY_CAP } from "./config";
import { defByIndex } from "./catalog";
import { dealDamage } from "./damage";
import { castCard, type EngineSink } from "./resolve";
import { flagsOf } from "./scripts";
import { newInstance, type CardInstance } from "./state";
import { cardAt, isUnitToken, moveToZone, slotsOf } from "./zones";

/** #75: a backrow card that turns an empty-library draw into a Rush Token card. */
function infiniteReservesSource(sink: EngineSink, player: PlayerId): CardInstance | null {
  for (const ref of slotsOf(player, "backrow")) {
    const card = cardAt(sink.state, ref);
    if (card !== null && flagsOf(card).infiniteReserves === true) return card;
  }
  return null;
}

/** §2.4, R4: a card entering a full hand is burned to the graveyard; unit tokens vanish (R11). */
export function addToHand(sink: EngineSink, instance: CardInstance): "hand" | "burned" {
  const side = sink.state.players[instance.owner];
  if (side.hand.length >= HAND_CAP) {
    const token = isUnitToken(sink.state, instance);
    moveToZone(sink.state, instance, "graveyard");
    sink.events.push({
      type: "burned",
      instanceId: instance.id,
      defId: instance.defId,
      owner: instance.owner,
    });
    if (!token) {
      sink.events.push({
        type: "enteredGraveyard",
        instanceId: instance.id,
        defId: instance.defId,
        owner: instance.owner,
      });
    }
    return "burned";
  }
  moveToZone(sink.state, instance, "hand");
  sink.events.push({
    type: "addedToHand",
    player: instance.owner,
    instanceId: instance.id,
    defId: instance.defId,
  });
  return "hand";
}

/** R80: a library holds at most LIBRARY_CAP cards, so copies stop being created at the cap. */
export function shuffleIntoLibrary(sink: EngineSink, instance: CardInstance, existing: boolean): "library" | "dropped" {
  const side = sink.state.players[instance.owner];
  if (side.library.length >= LIBRARY_CAP) {
    if (!existing) return "dropped";
    if (isUnitToken(sink.state, instance)) {
      moveToZone(sink.state, instance, "exile");
      return "dropped";
    }
    moveToZone(sink.state, instance, "graveyard");
    sink.events.push({
      type: "enteredGraveyard",
      instanceId: instance.id,
      defId: instance.defId,
      owner: instance.owner,
    });
    return "dropped";
  }
  const position = sink.rng.int(side.library.length + 1);
  moveToZone(sink.state, instance, "library", { position });
  sink.events.push({
    type: "shuffledIn",
    player: instance.owner,
    instanceId: instance.id,
    defId: instance.defId,
    position,
  });
  return "library";
}

export type DrawOutcome = "drawn" | "cast" | "burned" | "fatigue" | "token";

/**
 * One draw (§2.4). A cast-on-draw card resolves at once and the draw repeats, up to
 * CAST_ON_DRAW_CHAIN_CAP casts (R58); the next such card goes to hand uncast and ends the chain.
 */
export function drawOne(sink: EngineSink, player: PlayerId, chain = 0): DrawOutcome {
  const side = sink.state.players[player];

  if (side.library.length === 0) {
    const reserves = infiniteReservesSource(sink, player);
    if (reserves !== null) {
      const tokenDef = defByIndex("T-rush");
      if (tokenDef !== undefined) {
        const token = newInstance(sink.state, tokenDef.id, player, { z: "hand", player });
        sink.state.counters.drawn += 1;
        sink.events.push({ type: "drawn", player, instanceId: token.id, defId: token.defId });
        addToHand(sink, token);
        return "token";
      }
    }
    // No card is drawn, so no `drawn` event: the damage instance is what happened (§2.4, R3).
    side.fatigueCount += 1;
    const amount = FATIGUE_DAMAGE(side.fatigueCount);
    dealDamage(sink, { source: null, target: { kind: "hero", player }, amount });
    return "fatigue";
  }

  const card = side.library[0] as CardInstance;
  side.library.splice(0, 1);
  sink.state.counters.drawn += 1;
  sink.events.push({ type: "drawn", player, instanceId: card.id, defId: card.defId });

  if (flagsOf(card).castOnDraw === true && chain < CAST_ON_DRAW_CHAIN_CAP) {
    card.zone = { z: "resolving", player };
    castCard(sink, card);
    drawOne(sink, player, chain + 1);
    return "cast";
  }

  return addToHand(sink, card) === "burned" ? "burned" : "drawn";
}

export function draw(sink: EngineSink, player: PlayerId, count: number): DrawOutcome[] {
  const out: DrawOutcome[] = [];
  for (let i = 0; i < count; i += 1) out.push(drawOne(sink, player, 0));
  return out;
}
