// What one player is allowed to see, and nothing else (SPEC §10.8). The client renders this view
// and never holds rules or hidden information (CLAUDE.md rule 7, §9.1's trust model).
//
// The view is built by *copying* what the viewer is entitled to, never by deleting fields from a
// state clone: a field added to `GameState` stays invisible until this file names it. Five rules do
// all the work here.
//   - §9.1 hidden list: library order and contents, the opponent's hand, face-down traps. Both
//     libraries and the opponent's hand travel as counts; graveyards, exile and Field Spells are
//     public.
//   - R33: a face-down trap is readable by its *current controller* only, so a steal, a board swap
//     or a rotation moves who may read it even though ownership never changed; a Field Trap that
//     has fired (`faceUp`) is public to both.
//   - R13, §3.2: the lower cards of a Stack pile are dormant and not on the field. The view shows
//     the top card and a count of what is buried under it, never a buried card's identity.
//   - R81: only the viewer's own prompt carries its options; the other player's prompt shows that
//     it is open and whose it is, nothing more.
//   - R97: the event stream is redacted, not truncated. An event that names a card the viewer may
//     not read keeps its type and its animation fields and shows `HIDDEN_ID` for that card.
//
// Stats are never read off an instance: `layers.unitView` recomputes every stat and keyword on read
// (§10.4), so no stored total ever reaches the client.

import type {
  BackrowView,
  CardView,
  GameEvent,
  HeroPowerView,
  PendingOption,
  PendingView,
  PlayerId,
  PlayerView,
  Row,
  SideView,
  UnitView,
} from "@jackioh/shared";
import { PLAYER_IDS, opponentOf } from "@jackioh/shared";
import { defOf, findDef } from "./catalog";
import { hasExertion } from "./combat";
import { heroArmorOf } from "./damage";
import { unitView as unitLayers } from "./layers";
import { effectiveCost } from "./mana";
import {
  findInstance,
  type CardInstance,
  type GameState,
  type Pile,
  type PlayerState,
  type PromptOption,
} from "./state";
import { powerCostOf, powerOf, usedThisTurn } from "./subsystems/heroPower";
import { isReserved, slotsOf } from "./zones";

/** §10.8, §10.10: how many of the most recent events the view carries for animation. */
export const VIEW_EVENT_LIMIT = 32;

/**
 * R97's sentinel: the identity an event carries in place of a card the viewer may not read. Real
 * ids are `c<n>` for instances and catalog ids like `core-043` for definitions, so this collides
 * with neither and the client can test for it — a redacted event still animates, as a card back.
 */
export const HIDDEN_ID = "hidden";

/** R97, §9.1: the slot a shuffled-in card landed in would give away library order, to either side. */
const HIDDEN_POSITION = -1;

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

/**
 * §10.8: "traps show as unknown, Field Spells are public". A backrow Trap or Field Trap is readable
 * by its current controller only until it flips face-up, which is what R33 keys on `controller`.
 */
function backrowIsPublic(state: GameState, card: CardInstance, viewer: PlayerId): boolean {
  const type = defOf(state, card.defId).type;
  if (type !== "Trap" && type !== "Field Trap") return true;
  if (card.faceUp === true) return true;
  return card.controller === viewer;
}

/**
 * R97: whether this viewer may read the identity of the card an event names, judged by where the
 * card sits *now* and not where it was — so a card drawn last turn and played this turn reads
 * openly in both events, and a unit bounced into the opponent's hand stops reading the moment it
 * lands there (§9.1).
 *
 * A card in the resolving zone is public: playing it was public, and R98 keeps it itself while it
 * sits there. A card the state no longer holds at all is a unit token that has ceased to exist
 * (R11) or one that was exiled out of existence (R86); both were public when the event fired.
 */
function mayRead(state: GameState, viewer: PlayerId, instanceId: string): boolean {
  const card = findInstance(state, instanceId);
  if (card === undefined) return true;
  const zone = card.zone;
  if (zone.z === "library") return false;
  if (zone.z === "hand") return zone.player === viewer;
  if (zone.z === "field" && zone.row === "backrow") return backrowIsPublic(state, card, viewer);
  // Units, graveyard, exile, `resolving` (R98) and `gone` (R11, R86) are all public.
  return true;
}

// ---------------------------------------------------------------------------
// Cards, units and the backrow
// ---------------------------------------------------------------------------

/** R65: the cost as it stands now. An X card has no chosen X outside a play, so it reads 0. */
function cardView(state: GameState, card: CardInstance): CardView {
  return {
    instanceId: card.id,
    defId: card.defId,
    radiant: card.radiant,
    cost: effectiveCost(state, card),
  };
}

/**
 * The card that acts in a unit zone: the top of the pile (§3.2). `buried` is how many dormant cards
 * sit under it (R13) — a count, so no buried identity reaches either player.
 */
function unitViewOf(state: GameState, pile: Pile): UnitView | null {
  const top = pile[0];
  if (top === undefined) return null;
  const layers = unitLayers(state, top);
  return {
    ...cardView(state, top),
    owner: top.owner,
    controller: top.controller,
    attack: layers.attack,
    maxHealth: layers.maxHealth,
    health: layers.health,
    keywords: layers.keywords,
    armor: layers.armor,
    position: layers.position,
    counters: { ...top.counters },
    buried: pile.length - 1,
    canAct: canAct(state, top),
  };
}

/**
 * §4.1: "each unit has one exertion per turn: one attack or one position switch", so a unit can
 * still act while either exertion is unspent — a summoning-sick unit may still switch, and a unit
 * that cannot attack may still switch back. `combat.hasExertion` owns that rule, Deft Duelist's
 * two exertions included (#45); *which* of the two is legal is `combat.canAttack`'s answer and
 * `legalActions`', never the view's.
 */
function canAct(state: GameState, card: CardInstance): boolean {
  if (state.result !== null || state.phase !== "main") return false;
  if (state.pending !== null) return false;
  if (state.active !== card.controller) return false;
  return hasExertion(card, "attack") || hasExertion(card, "switch");
}

/**
 * A public backrow card names its owner and its controller, since R33's readability and #87's board
 * swap both turn on the controller and a stolen card sits in a backrow that is not its own. A
 * face-down zone is a bare `{ faceDown: true }`: §10.8 grants the non-controller that a zone is
 * occupied and nothing more, so not even the controller's name travels with it.
 */
function backrowView(state: GameState, card: CardInstance | null, viewer: PlayerId): BackrowView {
  if (card === null) return null;
  if (!backrowIsPublic(state, card, viewer)) return { faceDown: true };
  const grade = card.counters.grade;
  return {
    ...cardView(state, card),
    faceDown: false,
    type: defOf(state, card.defId).type,
    counters: grade === undefined ? {} : { grade },
    owner: card.owner,
    controller: card.controller,
  };
}

/**
 * R43: a Heroic Power lives on its instance and it is a Field Spell (§8 #98), so it is public to
 * both players once it is on the field — the row §2's hero panel marks visible to both. The power,
 * its X and its use are `heroPower`'s to report, never re-derived here.
 *
 * It follows control, not ownership: a stolen Heroic Power powers its new controller's hero. So a
 * player can hold more than one — their own plus one taken with #36 radiant or #49 — and each is
 * separately once-per-turn, which is why this is a list and every entry carries its `instanceId`
 * for `activatePower` (§10.2). Board order: p1's backrow lane 1 to 5, then p2's.
 */
function heroPowersOf(state: GameState, player: PlayerId): HeroPowerView[] {
  const powers: HeroPowerView[] = [];
  for (const side of PLAYER_IDS) {
    for (const card of state.players[side].backrow) {
      if (card === null || card.controller !== player) continue;
      const power = powerOf(card);
      if (power === null) continue;
      powers.push({
        instanceId: card.id,
        defId: card.defId,
        name: power.name,
        x: powerCostOf(card),
        usedThisTurn: usedThisTurn(state, card),
      });
    }
  }
  return powers;
}

// ---------------------------------------------------------------------------
// One side of the board
// ---------------------------------------------------------------------------

/** R64: the zones this player is holding for a dying Reborn unit, as a mask per row. */
function reservedMask(state: GameState, player: PlayerId): { units: boolean[]; backrow: boolean[] } {
  const mask = (row: Row): boolean[] => slotsOf(player, row).map((ref) => isReserved(state, ref));
  return { units: mask("units"), backrow: mask("backrow") };
}

function sideView(state: GameState, player: PlayerId, viewer: PlayerId): SideView {
  const side: PlayerState = state.players[player];
  const powers = heroPowersOf(state, player);
  return {
    player,
    hero: {
      health: side.hero.health,
      // §10.8's "armor": the number §4.4 step 2 will actually subtract, so the hero panel is read
      // the same way a unit's is — never the stored field alone. `heroArmorOf` adds every backrow
      // grant (#84 Going Long) to it, summed per R124, and the grant disappears from the view the
      // moment the granting card leaves the backrow.
      armor: heroArmorOf(state, player),
      powers,
      power: powers[0] ?? null,
    },
    mana: { current: side.mana.current, max: side.mana.max },
    // §10.8: the viewer's own hand in full, the opponent's as a count.
    hand: player === viewer ? side.hand.map((card) => cardView(state, card)) : { count: side.hand.length },
    // §9.1: a library is a count for both players; nothing in it, and no order, ever ships.
    libraryCount: side.library.length,
    graveyard: side.graveyard.map((card) => cardView(state, card)),
    exile: side.exile.map((card) => cardView(state, card)),
    // §10.5 step 4, R98: a Spell between its play and its graveyard. Playing it was public.
    resolving: side.resolving.map((card) => cardView(state, card)),
    units: side.units.map((pile) => (pile === null ? null : unitViewOf(state, pile))),
    backrow: side.backrow.map((card) => backrowView(state, card, viewer)),
    locks: { units: [...side.locks.units], backrow: [...side.locks.backrow] },
    reserved: reservedMask(state, player),
    fatigueCount: side.fatigueCount,
  };
}

// ---------------------------------------------------------------------------
// The open prompt
// ---------------------------------------------------------------------------

/**
 * §10.8: "a card revealed out of a library is revealed only as an option of the prompt that reveals
 * it: the chooser sees it in full". These options only ever travel to the chooser (R81), so naming
 * the definition behind an option is exactly what the chooser is owed.
 */
function optionView(state: GameState, option: PromptOption): PendingOption {
  const base = { key: option.key, label: option.label };
  const selection = option.selection;
  switch (selection.pick) {
    case "instance": {
      const card = findInstance(state, selection.instanceId);
      return card === undefined
        ? { ...base, instanceId: selection.instanceId }
        : { ...base, instanceId: selection.instanceId, defId: card.defId };
    }
    case "hero":
      return { ...base, player: selection.player };
    case "zone":
      return { ...base, player: selection.player, row: selection.row, lane: selection.lane };
    case "mode": {
      // §6.3 Discover offers definitions, as `mode` options whose string is a catalog def id.
      const def = findDef(state, selection.option);
      return def === undefined ? base : { ...base, defId: def.id };
    }
    case "none":
      return base;
  }
}

/** §10.6, R81: the other player learns that a prompt is open and whose it is, never its options. */
function pendingView(state: GameState, viewer: PlayerId): PendingView | null {
  const pending = state.pending;
  if (pending === null) return null;
  if (pending.playerId !== viewer) return { forYou: false, pendingFor: pending.playerId };
  return {
    forYou: true,
    choiceId: pending.id,
    kind: pending.kind,
    options: pending.options.map((option) => optionView(state, option)),
    min: pending.min,
    max: pending.max,
    prompt: pending.prompt,
  };
}

// ---------------------------------------------------------------------------
// Events (§10.10)
// ---------------------------------------------------------------------------

/**
 * R97. Every event carries ids and several carry a `defId` as well — `drawn` names the card that
 * went into a hand, `bounced` the one that left the field for it, `costChanged` a card discounted
 * in hand — so the animation stream is filtered like every other zone. An event that names a card
 * this viewer may not read keeps its type and every field §10.10's animation table needs, with the
 * identity replaced by `HIDDEN_ID`: redacted, never dropped, so the cue still plays as a card back.
 *
 * The switch is exhaustive over all 40 event types on purpose (§10.3): with no `default`, adding an
 * event type does not compile until someone decides what it reveals.
 */
function redactEvent(state: GameState, viewer: PlayerId, event: GameEvent): GameEvent {
  const hidden = (id: string): boolean => !mayRead(state, viewer, id);

  switch (event.type) {
    // A card named with its definition: both go, or neither.
    //
    // `cardResolved` (§10.5 step 7) belongs here rather than among the public events below: R97
    // judges a card by where it sits *now*, and once resolution is over a Spell has reached the
    // graveyard and a permanent is on the field, both public — so it ordinarily reads openly, and
    // `mayRead` keeps the sentinel for the card that ended up somewhere this viewer may not read
    // (a Trap set face-down, a card resolved back into a hand or a library). Its `player` and
    // `permanent` are not identity fields and never travel redacted; `permanent` is R61's "still
    // in play" answer, which #85 keys on.
    case "cardPlayed":
    case "cardResolved":
    case "summoned":
    case "destroyed":
    case "enteredGraveyard":
    case "exiled":
    case "bounced":
    case "burned":
    case "discarded":
    case "drawn":
    case "addedToHand":
    case "trapFired":
    case "radiantSet":
      return hidden(event.instanceId) ? { ...event, instanceId: HIDDEN_ID, defId: HIDDEN_ID } : event;

    // §9.1: library order is hidden from both players, so the slot never travels either way.
    case "shuffledIn":
      return hidden(event.instanceId)
        ? { ...event, instanceId: HIDDEN_ID, defId: HIDDEN_ID, position: HIDDEN_POSITION }
        : { ...event, position: HIDDEN_POSITION };

    case "transformed":
      return {
        ...event,
        ...(hidden(event.instanceId) ? { instanceId: HIDDEN_ID, fromDefId: HIDDEN_ID } : {}),
        ...(hidden(event.newInstanceId) ? { newInstanceId: HIDDEN_ID, toDefId: HIDDEN_ID } : {}),
      };

    case "fused":
      return {
        ...event,
        instanceIds: event.instanceIds.map((id) => (hidden(id) ? HIDDEN_ID : id)),
        ...(hidden(event.resultInstanceId) ? { resultInstanceId: HIDDEN_ID, defId: HIDDEN_ID } : {}),
      };

    // One instance, no definition: the id alone would still name a card in a hidden zone.
    case "divineShieldLost":
    case "buffed":
    case "keywordGranted":
    case "counterChanged":
    case "costChanged":
    case "positionSwitched":
    case "controlChanged":
      return hidden(event.instanceId) ? { ...event, instanceId: HIDDEN_ID } : event;

    case "healed":
      return hidden(event.targetId) ? { ...event, targetId: HIDDEN_ID } : event;

    case "damage":
      return {
        ...event,
        sourceId: event.sourceId !== null && hidden(event.sourceId) ? HIDDEN_ID : event.sourceId,
        targetId: hidden(event.targetId) ? HIDDEN_ID : event.targetId,
      };

    case "attackDeclared":
      return {
        ...event,
        attackerId: hidden(event.attackerId) ? HIDDEN_ID : event.attackerId,
        targetId: hidden(event.targetId) ? HIDDEN_ID : event.targetId,
      };

    case "attackCancelled":
      return {
        ...event,
        attackerId: hidden(event.attackerId) ? HIDDEN_ID : event.attackerId,
        targetId: hidden(event.targetId) ? HIDDEN_ID : event.targetId,
        byInstanceId: hidden(event.byInstanceId) ? HIDDEN_ID : event.byInstanceId,
      };

    // Public through and through: these name a player, a zone or a number, never a card. A
    // `promptOpened` event says a prompt is open and whose, which is all §10.6 grants.
    case "healthLost":
    case "modifierChanged":
    case "rotated":
    case "swapped":
    case "locked":
    case "manaChanged":
    case "turnStarted":
    case "turnEnded":
    case "turnAutoEnded":
    case "promptOpened":
    case "promptAnswered":
    case "drawOffered":
    case "drawAnswered":
    case "gameOver":
      return event;
  }
}

/**
 * §10.8: "the last N events for animation". `state.applied` is the only event history a state
 * carries (§9.3's nonce dedupe), oldest action first, so flattening it in order and taking the tail
 * is the stream — and it is bounded by `NONCE_HISTORY` already.
 */
function recentEvents(state: GameState, viewer: PlayerId): GameEvent[] {
  const all = state.applied.flatMap((entry) => entry.events);
  return all.slice(Math.max(0, all.length - VIEW_EVENT_LIMIT)).map((event) => redactEvent(state, viewer, event));
}

// ---------------------------------------------------------------------------
// §10.8
// ---------------------------------------------------------------------------

/**
 * The one window a player has onto a match (SPEC §10.8). Pure: it reads the state and builds a
 * fresh object, sharing nothing mutable with it.
 *
 * `clockMs` is the turn clock the server is running (R79). The engine never reads a clock, so the
 * caller passes the number in and it is `null` whenever nobody is counting.
 */
export function viewFor(state: GameState, playerId: PlayerId, clockMs: number | null = null): PlayerView {
  return {
    viewer: playerId,
    turn: state.turn,
    active: state.active,
    phase: state.phase,
    you: sideView(state, playerId, playerId),
    opponent: sideView(state, opponentOf(playerId), playerId),
    pending: pendingView(state, playerId),
    events: recentEvents(state, playerId),
    result: state.result === null ? null : { winner: state.result.winner, reason: state.result.reason },
    clockMs,
  };
}
