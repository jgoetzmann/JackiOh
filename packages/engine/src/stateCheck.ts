// Deaths and the state check (SPEC §4.5). Run after each action, each whole effect or trigger, each
// cast-on-draw cast and each combat, never between the hits of one effect (R59).
// M2-T5 adds the full test set; the loop itself is here.

import type { PlayerId } from "@jackioh/shared";
import { PLAYER_IDS, hasKeyword } from "@jackioh/shared";
import { unitView } from "./layers";
import type { EngineSink } from "./resolve";
import { runHook } from "./resolve";
import type { CardInstance } from "./state";
import {
  activeUnitsOf,
  cardAt,
  dormantUnitsOf,
  moveToZone,
  placeOnField,
  releaseZone,
  reserveZone,
  slotOf,
  slotsOf,
} from "./zones";

/** Every unit on the field, top of pile first, then dormant Stack cards (§3.2). */
function unitsOf(sink: EngineSink, player: PlayerId): CardInstance[] {
  return [...activeUnitsOf(sink.state, player), ...dormantUnitsOf(sink.state, player)];
}

/**
 * §4.5 step 1: a unit dies at 0 or less health or when marked destroyed. Indestructible units are
 * not collected for damage or a destroy mark, but one whose max health has fallen to 0 or less is
 * (R69); one merely at 0 or less health with positive max health stays.
 */
function isDying(sink: EngineSink, unit: CardInstance): boolean {
  const view = unitView(sink.state, unit);
  const indestructible = hasKeyword(view.keywords, "Indestructible");
  if (indestructible) return view.maxHealth <= 0;
  return view.health <= 0 || unit.markedDestroyed === true;
}

function heroCheck(sink: EngineSink): boolean {
  const dead = PLAYER_IDS.filter((player) => sink.state.players[player].hero.health <= 0);
  if (dead.length === 0) return false;
  const winner = dead.length === 2 ? "draw" : (dead[0] === "p1" ? "p2" : "p1");
  const reason = dead.length === 2 ? "both-heroes-dead" : "hero-death";
  sink.state.result = { winner, reason };
  sink.state.phase = "over";
  sink.events.push({ type: "gameOver", winner, reason });
  return true;
}

/** Every backrow card in play for this player, in lane order (§3). */
function backrowOf(sink: EngineSink, player: PlayerId): CardInstance[] {
  return slotsOf(player, "backrow").flatMap((ref) => {
    const card = cardAt(sink.state, ref);
    return card === null ? [] : [card];
  });
}

/**
 * R46: a marked Indestructible unit switches to Attack Position and loses Taunt for the turn.
 * A backrow card has no position, so an Indestructible Field Spell simply keeps its zone and the
 * mark is dropped with no event.
 */
function resolveIndestructibleMarks(sink: EngineSink): void {
  for (const player of PLAYER_IDS) {
    for (const unit of unitsOf(sink, player)) {
      if (unit.markedDestroyed !== true) continue;
      const view = unitView(sink.state, unit);
      if (!hasKeyword(view.keywords, "Indestructible") || view.maxHealth <= 0) continue;
      unit.markedDestroyed = false;
      unit.position = "ATK";
      unit.tauntSuppressedTurn = sink.state.turn;
      sink.events.push({ type: "positionSwitched", instanceId: unit.id, position: "ATK" });
    }
    for (const card of backrowOf(sink, player)) {
      if (card.markedDestroyed !== true) continue;
      if (!hasKeyword(unitView(sink.state, card).keywords, "Indestructible")) continue;
      card.markedDestroyed = false;
    }
  }
}

/** §4.5 loops until nothing changes; this bounds a pathological loop loudly (R69, R89). */
export const STATE_CHECK_PASS_CAP = 100;

export function stateCheck(sink: EngineSink): void {
  for (let pass = 0; pass < STATE_CHECK_PASS_CAP; pass += 1) {
    if (sink.state.result !== null) return;
    resolveIndestructibleMarks(sink);

    // Step 1: collect, in R68's order, and move them all at once — units by health or a destroy
    // mark, backrow cards by a destroy mark, since they have no health of their own.
    const order: PlayerId[] = sink.state.active === "p1" ? ["p1", "p2"] : ["p2", "p1"];
    const dying = [
      ...order.flatMap((player) => unitsOf(sink, player).filter((unit) => isDying(sink, unit))),
      ...order.flatMap((player) =>
        backrowOf(sink, player).filter((card) => card.markedDestroyed === true),
      ),
    ];

    if (dying.length === 0) {
      if (heroCheck(sink)) return;
      return;
    }

    const reborn: { unit: CardInstance; at: ReturnType<typeof slotOf> }[] = [];
    // R78 resets an instance as it leaves, so a Death hook reads this snapshot instead (R89).
    const snapshots = new Map<string, CardInstance>();
    for (const unit of dying) {
      const view = unitView(sink.state, unit);
      const at = slotOf(sink.state, unit);
      const hasReborn = hasKeyword(view.keywords, "Reborn");
      snapshots.set(unit.id, JSON.parse(JSON.stringify(unit)) as CardInstance);
      if (hasReborn && at !== null) {
        reserveZone(sink.state, at);
        reborn.push({ unit, at });
      }
      sink.state.counters.destroyed += 1;
      // R89: the event carries what the card was, since R78 resets the instance as it leaves.
      sink.events.push({
        type: "destroyed",
        instanceId: unit.id,
        defId: unit.defId,
        owner: unit.owner,
        attack: view.attack,
        maxHealth: view.maxHealth,
        killerId: unit.lastDamagedBy ?? null,
      });
      moveToZone(sink.state, unit, "graveyard");
    }

    // Step 2: heroes.
    if (heroCheck(sink)) return;

    // Step 3: Death triggers, reading each unit as it was just before it left (R78).
    for (const unit of dying) {
      runHook(sink, snapshots.get(unit.id) ?? unit, "death");
    }

    // Step 4: Reborn returns to its reserved zone at 1 health without Reborn (§4.5, R64).
    for (const entry of reborn) {
      if (entry.at === null) continue;
      releaseZone(sink.state, entry.at);
      const copy = entry.unit;
      copy.grantedKeywords = copy.grantedKeywords.filter((k) => k.kind !== "Reborn");
      copy.vanilla = false;
      const back = placeOnField(sink.state, copy, entry.at);
      if (!back) continue;
      const view = unitView(sink.state, copy);
      copy.damage = Math.max(0, view.maxHealth - 1);
      copy.rebornSpent = true;
      // R83: it enters the field again now, so it is summoning sick like any fresh summon.
      copy.summonedTurn = sink.state.turn;
      sink.state.players[copy.owner].graveyard = sink.state.players[copy.owner].graveyard.filter(
        (card) => card.id !== copy.id,
      );
      sink.events.push({
        type: "summoned",
        player: copy.controller,
        instanceId: copy.id,
        defId: copy.defId,
        row: entry.at.row,
        lane: entry.at.lane,
      });
    }

    // A card that came straight back through Reborn never stayed in the graveyard, so only the
    // ones still there are reported — including a Reborn whose zone was Locked meanwhile (R47).
    for (const unit of dying) {
      const stayed = sink.state.players[unit.owner].graveyard.some((card) => card.id === unit.id);
      if (!stayed) continue;
      sink.events.push({
        type: "enteredGraveyard",
        instanceId: unit.id,
        defId: unit.defId,
        owner: unit.owner,
      });
    }
  }

  // §4.5 repeats "until nothing changes"; a board that never settles is a bug, not a draw.
  throw new Error(`the board did not settle in ${STATE_CHECK_PASS_CAP} passes`);
}
