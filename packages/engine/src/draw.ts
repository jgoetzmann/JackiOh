// Drawing, fatigue, the hand cap, cast-on-draw chains and the library cap
// (SPEC §2.4, R3, R4, R58, R80), and the arrival hook of R151.

import type { PlayerId } from "@jackioh/shared";
import { CAST_ON_DRAW_CHAIN_CAP, FATIGUE_DAMAGE, HAND_CAP, LIBRARY_CAP } from "./config";
import { defByIndex } from "./catalog";
import { dealDamage } from "./damage";
import { castCard, runHook, type EngineSink } from "./resolve";
import { flagsOf, scriptOf } from "./scripts";
import { newInstance, type CardInstance } from "./state";
import { cardAt, isUnitToken, moveToZone, slotsOf } from "./zones";

/**
 * R151: a card whose script has a start-of-game hook runs it when it ARRIVES in a hand or a
 * library, and not only at §2.1 step 4. R43 words the rule as an invariant rather than as a moment —
 * "at start of game every Heroic Power in either player's hand or library rolls its power … and one
 * that ends up in a hand or library with no `memory.power` (a bounced or reset instance, R78) rolls
 * as it arrives" — so a copy that reaches a hand later (#72 Reminisce out of a graveyard, a bounce,
 * a draw, a card an effect created) has to roll too, or it carries no power and costs 0 for ever.
 *
 * GENERAL, NOT #98 BY ID: the test is `scriptOf(card).startOfGame`, the same thing `setup.finishSetup`
 * reads, so any card that ever grows a start-of-game clause is covered without the engine naming a
 * catalog id. Re-running it is safe because the hook is the one that owns its own idempotence:
 * `heroPower.ensurePower` keeps a power a card already rolled ("which is why it is idempotent rather
 * than a plain roll"), so an arrival costs no rng draw once the card has its answer.
 *
 * WHY HERE AND NOT IN `zones.moveToZone`, the single point every zone change goes through: the roll
 * needs the match rng, and `moveToZone` takes a `GameState`, which holds only the seed and the stored
 * cursor. A fresh `createRng(state.seed, state.rngCursor)` mid-action would repeat draws the action's
 * own rng has already taken, and `reduce` ends every action with `next.rngCursor = sink.rng.cursor`,
 * so the cursor it advanced would be discarded — two determinism bugs for one convenience. These two
 * functions are the sink-holding funnels §2.4 already routes every hand and library arrival through
 * (see the header of `effects/addToHand.ts`: "Both routes end in `../draw`'s `addToHand`").
 */
function runArrivalHooks(sink: EngineSink, instance: CardInstance): void {
  if (scriptOf(instance).startOfGame === undefined) return;
  runHook(sink, instance, "startOfGame", { controller: instance.owner });
}

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
  // R151: it has arrived somewhere it can be looked at, so a start-of-game clause runs now.
  runArrivalHooks(sink, instance);
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
  // R151: R43 names a library as well as a hand, so a card shuffled back rolls the same way.
  runArrivalHooks(sink, instance);
  return "library";
}

export type DrawOutcome = "drawn" | "cast" | "burned" | "fatigue" | "token";

/**
 * §2.4's draw from the moment the card has left the library: the game draw counter, the `drawn`
 * event, R58's cast-on-draw chain and R4's hand cap.
 *
 * `drawOne` below takes the top card and `effects/draw.ts`'s `drawFromLibrary` takes a NAMED one
 * (#30 Archivist's highest and lowest, #94 Genn's Greed's every 2-cost card), and both end here, so
 * "a draw" means exactly one thing however the card was chosen (§6.3 Draw). The caller splices the
 * card out of the library first: the pile must already be short by one when a cast-on-draw card
 * resolves, or its own script would read a library that still holds it.
 */
export function completeDraw(
  sink: EngineSink,
  player: PlayerId,
  card: CardInstance,
  chain = 0,
): DrawOutcome {
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
  return completeDraw(sink, player, card, chain);
}

export function draw(sink: EngineSink, player: PlayerId, count: number): DrawOutcome[] {
  const out: DrawOutcome[] = [];
  for (let i = 0; i < count; i += 1) out.push(drawOne(sink, player, 0));
  return out;
}
