// What a player is allowed to see (SPEC §10.8). The client renders this and nothing else.

import type { CardType, Keyword, PlayerId, PromptKind, Row } from "./catalog-types";
import type { GameEvent, GameOverReason } from "./events";

export type CardView = {
  instanceId: string;
  defId: string;
  radiant: boolean;
  /** Cost as it stands now (§6.3 Cost, R65); "X" cards show 0 until X is chosen. */
  cost: number;
};

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

export type SideView = {
  player: PlayerId;
  hero: HeroView;
  mana: { current: number; max: number };
  /** Full cards for the viewer; a count only for the opponent (§10.8). */
  hand: CardView[] | { count: number };
  libraryCount: number;
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
};
