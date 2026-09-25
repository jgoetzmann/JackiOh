// What a player is allowed to see (SPEC §10.8). The client renders this and nothing else.

import type { CardDef, CardType, Keyword, PlayerId, PromptKind, Row } from "./catalog-types";
import type { GameEvent, GameOverReason } from "./events";

export type CardView = {
  instanceId: string;
  defId: string;
  radiant: boolean;
  /** Cost as it stands now (§6.3 Cost, R65); "X" cards show 0 until X is chosen. */
  cost: number;
  /**
   * R243: a Unit card's stats in its owner's hand, as they stand: its printed face (the radiant one
   * when it is Radiant, a fused card's summed one) plus the permanent buffs it has gained there
   * (§10.4 layers 1, 3 and 4 — #89 Corpse Eater feeds in hand). Set on the viewer's own hand cards
   * only; a unit on the field reads its layers off `UnitView`.
   */
  attack?: number;
  health?: number;
  /**
   * R243, R43, R151: the power a #98 Heroic Power in its owner's hand rolled as it arrived, by name.
   * Its X is the card's cost, which does not name it: four of the seven powers cost the same.
   */
  power?: string;
  /**
   * R195, §10.8: Hearthstone's yellow glow. Present, and `true`, only on the viewer's own card
   * whose printed condition holds now. Absent otherwise: never `false`, never on the opponent's
   * cards. `UnitView` and the public `BackrowView` inherit it.
   */
  conditionActive?: true;
  /**
   * R280, §10.8: what the card's formula comes to now, one entry per labelled number its script's
   * `preview` hook returns — the label the formula as the running face prints it, the value what it
   * would come to if the card resolved now. Only on a card view the viewer may read: its own hand, a
   * unit on top of its pile, a face-up backrow card, a face-down one for its controller. Absent when
   * the hook returns nothing or the card has none.
   */
  preview?: PreviewValue[];
};

/** R280: one number a card's formula comes to now, and the formula it is ("+1 per card in your exile"). */
export type PreviewValue = { label: string; value: number };

export type UnitView = CardView & {
  owner: PlayerId;
  controller: PlayerId;
  attack: number;
  maxHealth: number;
  health: number;
  keywords: Keyword[];
  armor: number;
  position: "ATK" | "DEF";
  counters: { plague?: number; grade?: number };
  /** Cards under this one in a Stack pile are face-down and dormant (§3.2). */
  buried: number;
  canAct: boolean;
  /**
   * R243, §6.3 Vanilla, R115: the unit's text is gone — its printed keywords and every script, the
   * ones its definition still names included — so a client shows none of it. Absent otherwise.
   */
  vanilla?: true;
};

/**
 * A backrow zone: a public card, a face-down trap, or empty (§3, §10.8). A public card names its
 * `owner` and `controller` like a `UnitView` does, because R33 keys readability on the controller:
 * after a steal (#36 radiant, #49), a board swap (#87) or a rotation (#52) the card sits in a
 * backrow that is not its controller's, and the view says so rather than leaving the client to
 * track `controlChanged` out of band. A face-down zone stays a bare marker: §10.8 grants the
 * non-controller the fact that something is there and nothing else.
 */
export type BackrowView =
  | (CardView & {
      faceDown: false;
      type: CardType;
      counters: { grade?: number };
      owner: PlayerId;
      controller: PlayerId;
    })
  | { faceDown: true }
  | null;

/** A Heroic Power on the field (§8 #98, R43), as the client needs it to act. */
export type HeroPowerView = {
  /** #98's instance, so `activatePower {instanceId}` is built from the view alone (§10.2). */
  instanceId: string;
  defId: string;
  name: string;
  /** "Once per turn, spend X" (§8 #98): the X, which is also the card's cost (R43, R65). */
  x: number;
  usedThisTurn: boolean;
};

export type HeroView = {
  health: number;
  /**
   * The Armor §4.4 step 2 subtracts from each hit on this hero, as a computed total and not a
   * stored field: whatever is written on the hero plus every backrow card granting it (#84 Going
   * Long), which R124 adds up. So it drops back when a granting card leaves the backrow, exactly
   * like a unit's `armor` above.
   */
  armor: number;
  /**
   * Every Heroic Power this player controls, in board order. Usually none or one, but #36 radiant
   * and #49 steal a backrow permanent and a Field Spell is one (§3), so a player holding their own
   * #98 can come to control the opponent's as well — and each is separately once-per-turn (R43).
   */
  powers: HeroPowerView[];
  /** `powers[0] ?? null`: the one a single-button hero panel shows. */
  power: HeroPowerView | null;
};

/**
 * One player-level modifier (§10.1 `PlayerState.mods`) as the hero panel shows it.
 *
 * `id` is the `PlayerModifier.id` that §10.3's `modifierChanged` event already names on both
 * seats, so the badge an animation plays on is the badge the view carries. `label` is a short
 * caption built from the modifier's own kind and numbers — and its timing while R48 keeps it
 * dormant — and it is the *whole* of what a modifier reveals: never `sourceId`, never the card
 * that installed it, so nothing that could name a face-down card rides out on a badge.
 */
export type ModifierView = {
  id: string;
  label: string;
};

/**
 * R310: one kind of card left in the viewer's own library: a definition, the face it went in with
 * (R311) and how many such cards are there. No instance id and no position, so nothing in it can
 * say where a card lies.
 */
export type LibraryEntryView = { defId: string; radiant: boolean; count: number };

/**
 * R310–R312: the viewer's own library as a list without order. `cards` holds what the viewer was
 * shown of each card as it went in, one entry per definition and face, sorted by printed cost, then
 * name, then id, base face first (R310): an order that depends on the cards alone, never on where
 * they lie. `unknown` counts the cards the viewer was never shown (R312: a library Pocket Chaos
 * swapped in, Transmogulate's picks), which a client draws as backs. The two add up to
 * `libraryCount`.
 */
export type LibraryView = { cards: LibraryEntryView[]; unknown: number };

export type SideView = {
  player: PlayerId;
  hero: HeroView;
  /**
   * The player modifiers on this seat, in the order they were installed. Public on BOTH seats:
   * every modifier in the Core set is installed by the Cry of a card played face-up (§10.5 step 4,
   * #35, #77, #78, #79), and `modifierChanged` is already an unredacted event for both players, so
   * the label states only what the public play already said. Nothing derived from a hidden card
   * travels with it (see `ModifierView`).
   */
  modifiers: ModifierView[];
  mana: { current: number; max: number };
  /** Full cards for the viewer; a count only for the opponent (§10.8). */
  hand: CardView[] | { count: number };
  libraryCount: number;
  /**
   * R310: the viewer's own library, as a list without order. Present on the viewer's own side only;
   * the opponent's library is `libraryCount` and nothing else (§9.1, §10.8).
   */
  ownLibrary?: LibraryView;
  graveyard: CardView[];
  exile: CardView[];
  /**
   * Cards mid-resolution: a Spell between its play and its graveyard (§10.5 step 4). Public for
   * both sides — playing a card is public — and R98 makes one still itself while it sits here, so
   * a Spell that opened a prompt can be shown on the board instead of vanishing until it lands.
   */
  resolving: CardView[];
  units: (UnitView | null)[];
  backrow: BackrowView[];
  locks: { units: boolean[]; backrow: boolean[] };
  /**
   * R64: a zone held for a dying Reborn unit until it comes back. It takes no summon, exactly as a
   * Locked zone takes none, so a client that reads only `locks` would draw it open.
   */
  reserved: { units: boolean[]; backrow: boolean[] };
  fatigueCount: number;
};

export type PendingView =
  | { forYou: true; choiceId: string; kind: PromptKind; options: PendingOption[]; min: number; max: number; prompt: string }
  | { forYou: false; pendingFor: PlayerId };

export type PendingOption = {
  /** The selection to send back in an `answer` action. */
  key: string;
  label: string;
  instanceId?: string;
  defId?: string;
  player?: PlayerId;
  row?: Row;
  lane?: number;
};

/** R265, R266: the concurrent mulligan as one seat may see it. */
export type MulliganView = {
  youReady: boolean;
  opponentReady: boolean;
  /** The ids the viewer kept, once it has answered (R266). */
  kept?: string[];
};

export type PlayerView = {
  viewer: PlayerId;
  turn: number;
  active: PlayerId;
  phase: "setup" | "mulligan" | "start" | "main" | "end" | "over";
  you: SideView;
  opponent: SideView;
  pending: PendingView | null;
  /**
   * The last N events, for animation (§10.10). Redacted, not truncated: an event that names a card
   * this viewer may not read keeps its type and its animation fields and carries the sentinel
   * `"hidden"` in place of that card's `instanceId` and `defId` (R97).
   */
  events: GameEvent[];
  result: { winner: PlayerId | "draw"; reason: GameOverReason } | null;
  /** Milliseconds left on the turn clock, when the server is running one (R79). */
  clockMs: number | null;
  /**
   * §2.1 step 3, R265, R266: while both mulligans are open, whether each seat has answered, and the
   * ids the viewer itself kept once it has. Never the opponent's choice or cards (§9.1): that the
   * opponent is ready is all it shows. Absent outside that window.
   */
  mulligan?: MulliganView;
  /**
   * §2.5, R36, R269: the draw offer standing right now — made by the active player this turn and
   * not yet answered — on both seats, since the offer was public (`drawOffered`). Absent when none;
   * it disappears when the offer is answered or lapses at the end of the offerer's turn.
   */
  drawOffer?: { by: PlayerId };
  /**
   * R243: the definitions of the match-made cards this view names — a Fuse's (R77), a crafted
   * card's (R102, R179) — by id. They exist only in the match, so no catalog a client holds has
   * them, and a card the view shows could not otherwise be read. Only a card the viewer may read
   * brings its definition: a hidden one's id is already the sentinel (R97). Absent when none.
   */
  defs?: Record<string, CardDef>;
};
