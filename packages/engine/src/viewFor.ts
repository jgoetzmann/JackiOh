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
//   - R177: more fields follow R97 — a prompt option offering a face-down card names it by id only,
//     a `costChanged` on an unreadable card hides its cost and a `buffed` one its amounts, and a
//     `transformed` whose new card is unreadable hides the card it replaced, as does one whose old
//     card was unreadable where it ceased to exist (`hiddenFrom`), whatever became of its
//     replacement since.
//   - R169: the player modifiers (§10.1 `mods`) travel on both seats as `{ id, label }`, because
//     every one of them is installed by a card played FACE-UP and `modifierChanged` is already
//     public in both directions. Face-up, not "by a Cry": #35 and #78 are Spells and can never have
//     one, #64 and #79 install theirs without one, and only #77 is a Cry. The caption is built from
//     the modifier's own kind and numbers and never from its `sourceId`, so no card identity can
//     leave through a badge.
//
// Stats are never read off an instance: `layers.unitView` recomputes every stat and keyword on read
// (§10.4), so no stored total ever reaches the client.

import type {
  BackrowView,
  CardDef,
  CardView,
  GameEvent,
  HeroPowerView,
  ModifierView,
  PendingOption,
  PendingView,
  PlayerId,
  PlayerView,
  Row,
  SideView,
  UnitView,
  Zone,
} from "@jackioh/shared";
import { PLAYER_IDS, opponentOf } from "@jackioh/shared";
import { defOf, findDef } from "./catalog";
import { hasExertion } from "./combat";
import { heroArmorOf } from "./damage";
import { echoGrantOf } from "./echo";
import { statsWithBuffs, unitView as unitLayers } from "./layers";
import { NEXT_REFRESH_MODIFIER_ID, effectiveCost, modifierIsLive } from "./mana";
import {
  findInstance,
  type CardInstance,
  type GameState,
  type Pile,
  type PlayerModifier,
  type PlayerState,
  type PromptOption,
} from "./state";
import { powerCostOf, powerOf, usedThisTurn } from "./subsystems/heroPower";
import { returnedAwaitingShuffle } from "./setup";
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

/**
 * R177: the cost a `costChanged` event reports for a card the viewer may not read. A cost is a
 * property of the card as much as its definition is — the opponent's hand is a count (§10.8) — and
 * a sequence of costs over a library would spell out its order (§9.1).
 */
const HIDDEN_COST = -1;

/** R177: what a prompt option names when it offers a card the chooser may not read (§10.8, R33). */
export const HIDDEN_OPTION_LABEL = "Face-down card";

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

/** §10.8, R33: a card in the backrow that this viewer sees only as a face-down card. */
function isFaceDownTo(state: GameState, card: CardInstance, viewer: PlayerId): boolean {
  const zone = card.zone;
  return zone.z === "field" && zone.row === "backrow" && !backrowIsPublic(state, card, viewer);
}

/**
 * R177: the card that took each vanished card's place, read off the events that replaced it — a
 * Replace (`transformed`, §6.3, R35) or a Fuse (`fused`, R77) — so a card that has ceased to exist
 * can still be judged by a zone: its replacement's. `state.applied` holds every event a view can
 * show, so every replacement that matters to one is in it.
 */
type Replacements = {
  /** Each vanished card's replacement. */
  replacedBy: ReadonlyMap<string, string>;
  /** The players each replaced card was hidden from where it ceased to exist (`transformed.hiddenFrom`). */
  hiddenFrom: ReadonlyMap<string, readonly PlayerId[]>;
  /**
   * R224: the cards a mulligan returned that wait in setup's owed item for their shuffle-back, in no
   * pile (`setup.returnedAwaitingShuffle`). They are on their way to a library, so nobody reads them.
   */
  toLibrary?: ReadonlySet<string>;
};

function replacementsOf(events: readonly GameEvent[], state?: GameState): Replacements {
  const toLibrary = state === undefined ? undefined : new Set(returnedAwaitingShuffle(state));
  const replacedBy = new Map<string, string>();
  const hiddenFrom = new Map<string, readonly PlayerId[]>();
  for (const event of events) {
    if (event.type === "transformed" && event.newInstanceId !== event.instanceId) {
      replacedBy.set(event.instanceId, event.newInstanceId);
      if (event.hiddenFrom !== undefined) hiddenFrom.set(event.instanceId, event.hiddenFrom);
    }
    if (event.type === "fused") {
      for (const id of event.instanceIds) {
        if (id !== event.resultInstanceId) replacedBy.set(id, event.resultInstanceId);
      }
    }
  }
  return { replacedBy, hiddenFrom, ...(toLibrary === undefined || toLibrary.size === 0 ? {} : { toLibrary }) };
}

/**
 * R97: whether this viewer may read the identity of the card an event names, judged by where the
 * card sits *now* and not where it was — so a card drawn last turn and played this turn reads
 * openly in both events, and a unit bounced into the opponent's hand stops reading the moment it
 * lands there (§9.1).
 *
 * A card in the resolving zone is public: playing it was public, and R98 keeps it itself while it
 * sits there. A card the state no longer holds at all has ceased to exist, and R177 judges it by
 * the card that replaced it: a face-down trap #83 Transmogulate replaced keeps the secret its
 * replacement keeps, and a library #83 replaced still never reads, so its earlier `cardPlayed` or
 * `costChanged` cannot spell out what it was or in what order. With no replacement — a unit token
 * that left the field (R11), a card exiled out of existence (R86) — it was public when it went.
 */
function mayRead(state: GameState, viewer: PlayerId, instanceId: string, replaced: Replacements): boolean {
  const { replacedBy, hiddenFrom } = replaced;
  let id = instanceId;
  let card = findInstance(state, id);
  for (let hops = 0; card === undefined && hops < replacedBy.size; hops += 1) {
    // R177: a card that ceased to exist where this viewer could not read it — a library card, an
    // enemy face-down trap — stays unread for good. Its replacement may reach a public pile later,
    // and judged by that pile alone the card it replaced would read, though it never was public.
    if (hiddenFrom.get(id)?.includes(viewer) === true) return false;
    const next = replacedBy.get(id);
    if (next === undefined) break;
    id = next;
    card = findInstance(state, id);
  }
  // R224: a card the mulligan returned waits for its shuffle-back in no pile, and is a library card.
  if (card === undefined) return replaced.toLibrary?.has(id) !== true;
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
 * R243, §10.8: a card in the viewer's own hand, in full — what it is made of beyond its printed
 * face as well. A Unit's stats are its face plus the permanent buffs it gained in hand (§10.4
 * layers 1, 3 and 4: #89 Corpse Eater's meals), since layer 2 and the auras are the field's; attack
 * floors at 0 as on the field. A #98 Heroic Power names the power it rolled as it arrived (R43,
 * R151), which its cost alone does not.
 */
function handCardView(state: GameState, card: CardInstance): CardView {
  const view = cardView(state, card);
  const stats =
    defOf(state, card.defId).type === "Unit" ? statsWithBuffs(state, card) : null;
  const power = powerOf(card);
  return {
    ...view,
    ...(stats === null ? {} : { attack: Math.max(0, stats.attack), health: stats.maxHealth }),
    ...(power === null ? {} : { power: power.name }),
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
    // R243, §6.3 Vanilla: the text is gone, which the definition the client reads does not say.
    ...(top.vanilla === true ? { vanilla: true as const } : {}),
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
// Player modifiers (§10.1 `mods`, §10.3 `modifierChanged`)
// ---------------------------------------------------------------------------

/**
 * The discount half of `modifierLabel`, split out because `costDiscount` is the one kind whose
 * caption has to say *what* it applies to: R48's current-cost gate (#77), §8 #35's "next Spell",
 * and #78's flat "your cards" are three different sentences off one kind.
 */
function discountLabel(mod: Extract<PlayerModifier, { kind: "costDiscount" }>): string {
  const less = `cost${mod.oncePerTurn === true ? "s" : ""} ${mod.amount} less`;
  if (mod.onlyCurrentCost !== undefined) return `Cost-${mod.onlyCurrentCost} cards ${less}`;
  if (mod.onlyType !== undefined) {
    return mod.oncePerTurn === true ? `Next ${mod.onlyType} ${less}` : `${mod.onlyType}s ${less}`;
  }
  return mod.oncePerTurn === true ? `Next card ${less}` : `Your cards ${less}`;
}

/**
 * A badge caption for one modifier, built from the modifier alone. The switch is exhaustive over
 * `PlayerModifier["kind"]` on purpose: with no `default`, a new kind does not compile until someone
 * decides what the player is told about it.
 *
 * `sourceId` (#79 Twinspell's instance) is deliberately not read here: it is a card id, and the view
 * must not hand either seat an identity through a badge. `echo` is the grant as it stands
 * (`echo.echoGrantOf`), a number read off the permanent's current face (R209, §5.2).
 */
function modifierLabel(mod: PlayerModifier, echo: number): string {
  switch (mod.kind) {
    case "costDiscount":
      return discountLabel(mod);
    case "echoNextSpell":
      return `Next Spell gains Echo +${echo}`;
    case "radiantFirstCheapCard":
      return `First card costing ${mod.maxCost} or less becomes Radiant`;
    case "comboDraw":
      return `Your cards gain "Combo: draw ${mod.amount}"`;
    case "quickstrikerDamage":
      return `Your cards gain "Combo X: X damage to the enemy hero"`;
  }
}

/**
 * §10.8 does not list the player modifiers, so R169 decides them: both seats carry the list, since
 * every Core modifier is installed by a card played face-up and `modifierChanged` is already public
 * in both directions (see `redactEvent`). Only the id and the caption travel.
 *
 * "Face-up" is the load-bearing word and "Cry" would be wrong: #35 Lunar Eclipse and #78 /fullsend
 * are Spells, which never enter the field and so can never have a Cry; #64 and #79 install theirs
 * from other hooks. What all five share is that the play itself was public.
 *
 * R48: a modifier that covers the controller's *next* turn is installed at once and bites later, so
 * the caption says so while `modifierIsLive` is still false — otherwise #77's badge would claim a
 * discount on the very turn the discount does nothing.
 */
function modifierViews(state: GameState, player: PlayerId): ModifierView[] {
  const views = state.players[player].mods.map((mod) => {
    const label = modifierLabel(mod, echoGrantOf(state, player, mod));
    return { id: mod.id, label: modifierIsLive(state, mod) ? label : `${label} (next turn)` };
  });
  // §6.3 Mana: the next refresh's rider (#21 Hinder, #24 Efficiency Dividend) is a modifier too, one
  // badge under the id `modifierChanged` names for it, while it is not 0 (R169).
  const rider = state.players[player].mana.nextTurnMod;
  if (rider !== 0) {
    views.push({ id: NEXT_REFRESH_MODIFIER_ID, label: `Next refresh ${rider > 0 ? "+" : "−"}${Math.abs(rider)} mana` });
  }
  return views;
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
    // R169: the badge list beside the hero, public on both seats.
    modifiers: modifierViews(state, player),
    mana: { current: side.mana.current, max: side.mana.max },
    // §10.8: the viewer's own hand in full, the opponent's as a count.
    hand: player === viewer ? side.hand.map((card) => handCardView(state, card)) : { count: side.hand.length },
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
function optionView(state: GameState, viewer: PlayerId, option: PromptOption): PendingOption {
  const base = { key: option.key, label: option.label };
  const selection = option.selection;
  switch (selection.pick) {
    case "instance": {
      const card = findInstance(state, selection.instanceId);
      // R177: a prompt may offer a card its chooser may not read — a target prompt reaching an
      // enemy face-down trap (#49, #50, an Echo repeat's fresh pick). The option is the zone's card
      // and nothing more: the id to answer with, never the definition, and neither the label nor
      // the key the engine built from its name. A card revealed out of a library is the opposite
      // case: the prompt IS its reveal, so the chooser sees it in full (above).
      if (card !== undefined && isFaceDownTo(state, card, viewer)) {
        return { key: `instance:${selection.instanceId}`, label: HIDDEN_OPTION_LABEL, instanceId: selection.instanceId };
      }
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
    options: pending.options.map((option) => optionView(state, viewer, option)),
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
function redactEvent(state: GameState, viewer: PlayerId, event: GameEvent, replaced: Replacements): GameEvent {
  const hidden = (id: string): boolean => !mayRead(state, viewer, id, replaced);

  switch (event.type) {
    // A card named with its definition: both go, or neither.
    //
    // `cardResolved` (§10.5 step 7) is one of these rather than a public event: R97 judges a card
    // by where it sits *now*, and once resolution is over a Spell has reached the graveyard and a
    // permanent is on the field, both public — so it ordinarily reads openly, and `mayRead` keeps
    // the sentinel for the card that ended up somewhere this viewer may not read (a Trap set
    // face-down, a card resolved back into a hand or a library). Its `player` and `permanent` are
    // not identity fields and never travel redacted; `permanent` is R61's "still in play" answer,
    // which #85 keys on. The face that resolved (`radiant`) is the card's, so it goes with the id.
    case "cardResolved": {
      // R119's `arrivedDuring` is the engine's own bookkeeping, and it names face-down traps (#95);
      // so is the exit mark the event happened at (R174, R212).
      const { arrivedDuring: _arrivals, exitsFrom: _mark, ...shown } = event;
      if (!hidden(event.instanceId)) return shown;
      const { radiant: _face, ...rest } = shown;
      return { ...rest, instanceId: HIDDEN_ID, defId: HIDDEN_ID };
    }

    // R97, R177: `killerId` names a card as well, and the card that dealt the lethal hit — a unit,
    // or a Spell whose damage was lethal — may since have gone somewhere this viewer cannot read,
    // like the #31 KY's Math Equation that returns to its owner's hand at the end of the turn.
    case "destroyed": {
      const killerHidden = event.killerId !== null && hidden(event.killerId);
      const redacted = hidden(event.instanceId) ? { ...event, instanceId: HIDDEN_ID, defId: HIDDEN_ID } : event;
      return killerHidden ? { ...redacted, killerId: HIDDEN_ID } : redacted;
    }

    // R119's `arrivedDuring` and the exit mark on a play's step-4 pair are the engine's bookkeeping,
    // as on `cardResolved`.
    case "cardPlayed":
    case "summoned": {
      const { arrivedDuring: _arrivals, exitsFrom: _mark, ...shown } = event;
      return hidden(event.instanceId) ? { ...shown, instanceId: HIDDEN_ID, defId: HIDDEN_ID } : shown;
    }

    case "enteredGraveyard":
    case "exiled":
    case "bounced":
    case "burned":
    case "discarded":
    case "drawn":
    case "addedToHand":
      return hidden(event.instanceId) ? { ...event, instanceId: HIDDEN_ID, defId: HIDDEN_ID } : event;

    // R177: a Make Radiant on a card in a library (#42's roll over every card, top down) is one nobody
    // could read where it happened (§3), and read openly once the card does, its place in the batch
    // would say where it lay. The event's `zone` is where it happened, so it stays unread for good.
    //
    // And a cue on the other player's card this viewer may not read says only whose it was: a random
    // pick over several hidden zones (#28's hand, library and field) picks among non-Radiant cards
    // only (R60), so a cue located in the hand, or at a face-down trap's lane, would tell this viewer
    // that the hand still held a base-face card, or that the trap was base-face (R33). The zone is
    // given as that player's hand, the region this viewer is shown the player's unread cards in.
    case "radiantSet": {
      const unread = event.zone.z === "library" || hidden(event.instanceId);
      if (!unread) return event;
      const owner = event.zone.player;
      const zone: Zone = owner === viewer ? event.zone : { z: "hand", player: owner };
      return { ...event, instanceId: HIDDEN_ID, defId: HIDDEN_ID, zone };
    }

    /**
     * R154: the one identity R97's "judged by where the card sits now" cannot decide, so the row
     * names the seat instead — the controller reads `instanceId` and `defId`, the other player
     * reads the sentinel. Firing a Trap consumes it into its owner's graveyard (a public pile) or
     * leaves a Field Trap face-up, so `mayRead` would call every fired trap public and hand the
     * opponent the card's identity on the event that announces the flip. The animation needs the
     * opposite: §10.10's `trapFired` row flips a card back in the right lane, and §10.8 gives a
     * face-down trap no instance id to hang that on. `row`, `lane` and `controller` are not
     * identity and always travel, which is the whole point of the row — the opponent animates the
     * flip in the right zone without being told which card it was.
     */
    case "trapFired":
      return event.controller === viewer
        ? event
        : { ...event, instanceId: HIDDEN_ID, defId: HIDDEN_ID };

    // §9.1: library order is hidden from both players, so the slot never travels either way.
    case "shuffledIn":
      return hidden(event.instanceId)
        ? { ...event, instanceId: HIDDEN_ID, defId: HIDDEN_ID, position: HIDDEN_POSITION }
        : { ...event, position: HIDDEN_POSITION };

    // R177: a Replace puts the new card where the old one was (§6.3), and the old one ceased to
    // exist there (R35), so no zone of its own is left to judge it by — it is judged by its
    // replacement's. A card replaced inside a library or a face-down backrow zone never reads.
    case "transformed": {
      const newHidden = hidden(event.newInstanceId);
      const { hiddenFrom: _record, ...shown } = event;
      return {
        ...shown,
        ...(newHidden || hidden(event.instanceId) ? { instanceId: HIDDEN_ID, fromDefId: HIDDEN_ID } : {}),
        ...(newHidden ? { newInstanceId: HIDDEN_ID, toDefId: HIDDEN_ID } : {}),
      };
    }

    case "fused":
      return {
        ...event,
        instanceIds: event.instanceIds.map((id) => (hidden(id) ? HIDDEN_ID : id)),
        ...(hidden(event.resultInstanceId) ? { resultInstanceId: HIDDEN_ID, defId: HIDDEN_ID } : {}),
      };

    // R177: a buff's size is the card's too — #89 Corpse Eater gains double on its radiant face —
    // so a hidden card's buff keeps its type for the cue and says nothing of how much.
    case "buffed":
      return hidden(event.instanceId) ? { ...event, instanceId: HIDDEN_ID, attack: 0, health: 0 } : event;

    // One instance, no definition: the id alone would still name a card in a hidden zone.
    case "divineShieldLost":
    case "keywordGranted":
    case "counterChanged":
    case "positionSwitched":
    case "controlChanged":
      return hidden(event.instanceId) ? { ...event, instanceId: HIDDEN_ID } : event;

    // R177: the new cost is the card's too, and over a library it would give the order away — so a
    // change made in a library stays unread for good (`hiddenFrom`), whatever became of the card.
    case "costChanged": {
      const { hiddenFrom, ...shown } = event;
      return hiddenFrom?.includes(viewer) === true || hidden(event.instanceId)
        ? { ...shown, instanceId: HIDDEN_ID, cost: HIDDEN_COST }
        : shown;
    }

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
 *
 * `VIEW_EVENT_LIMIT` is a FLOOR, not a cap: the window never ends inside the newest applied action.
 * BUILD M5-T4 gives every §10.3 event an animation and `PlayerView.events` is the client's only
 * channel for them, so a fixed length silently drops the FRONT of any single action that emits more
 * than it — the client then animates the tail of something whose beginning it was never told about.
 * One #96 My Pawn cancel plus the §10.7 AI turn it hands over is 38 events in one `reduce`, and the
 * three the cancel is made of (`attackDeclared`, `trapFired`, `attackCancelled`) were exactly the
 * ones lost, which made M5-T4's `attackCancelled` row unreachable. Measured: 38 emitted, 32
 * carried, 6 dropped from the front.
 *
 * This is SPEC §11 R168, which states the floor and records the measurement above.
 */
function recentEvents(state: GameState, viewer: PlayerId): GameEvent[] {
  const all = state.applied.flatMap((entry) => entry.events);
  const newest = state.applied[state.applied.length - 1]?.events.length ?? 0;
  const window = Math.max(VIEW_EVENT_LIMIT, newest);
  const replaced = replacementsOf(all, state);
  return all
    .slice(Math.max(0, all.length - window))
    .map((event) => redactEvent(state, viewer, event, replaced));
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
  const view: PlayerView = {
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
  const defs = matchDefsIn(state, view);
  return Object.keys(defs).length === 0 ? view : { ...view, defs };
}

/**
 * R243: the match-made definitions (`state.transientDefs`: a Fuse's, a crafted card's — R77, R102,
 * R179) the finished view names anywhere — a card in a zone, a unit, a prompt option, an event —
 * copied beside it, since no catalog a client holds has them. The view is read after it is built,
 * so only an id that survived redaction brings its definition: a card this viewer may not read is
 * the sentinel by then (R97), and its definition stays in the match.
 */
function matchDefsIn(state: GameState, view: PlayerView): Record<string, CardDef> {
  const defs: Record<string, CardDef> = {};
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      // Own keys only: a label that happens to read "constructor" names no definition.
      if (!Object.prototype.hasOwnProperty.call(state.transientDefs, value) || value in defs) return;
      const def = state.transientDefs[value];
      if (def !== undefined) defs[value] = JSON.parse(JSON.stringify(def)) as CardDef;
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const item of Object.values(value)) visit(item);
    }
  };
  visit(view);
  return defs;
}
