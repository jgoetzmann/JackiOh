// The card-script contract (SPEC §10.9). A card file returns Effect[] from the effects library and
// never touches state itself (CLAUDE.md rule 5); the engine applies the effects.

import type { GameEvent, Keyword, ModeDecl, PlayerId, Selection, TargetDecl } from "@jackioh/shared";
import type { Rng } from "./rng";
import type { CardInstance, GameState } from "./state";

export type EffectContext = {
  state: GameState;
  rng: Rng;
  /** Effects append here; reduce returns the list (§10.3). */
  events: GameEvent[];
  /** Who is resolving this: the controller of `self`, or the player who cast the card. */
  controller: PlayerId;
  /** The instance whose script is running, when it still exists. */
  self: CardInstance | null;
  /** Whether the radiant text is the one running (§5.2). */
  radiant: boolean;
  targets: Selection[];
  modes: string[];
  x: number;
  embiggened: boolean;
  /** Captured data from a Resume, for chained steps (§10.6). */
  data: Record<string, unknown>;
};

/**
 * One state change from the effects library. Effects are built by engine code, so a card file
 * composing them stays pure.
 */
export type Effect = {
  readonly kind: string;
  apply: (ctx: EffectContext) => void;
};

export type Hook = (ctx: EffectContext) => Effect[];

/** A trigger a card registers while it is in a given zone (§10.3). */
export type TriggerDef = {
  id: string;
  /** Which events wake it. */
  on: GameEvent["type"][];
  /**
   * R99: the trigger's condition, kept out of `run` so a trap can decline an event without being
   * spent — R61 makes an empty effect list mean "fired and did nothing". Absent, the `on` match
   * alone arms it, so a trap with no predicate answers every event it names on either side.
   */
  when?: (ctx: EffectContext & { event: GameEvent }) => boolean;
  /** Reads the event and the state; returns the effects to queue, or none. */
  run: (ctx: EffectContext & { event: GameEvent }) => Effect[];
};

export type StatMod = {
  attack?: number;
  maxHealth?: number;
  keywords?: Keyword[];
};

/** An aura contributes stat and keyword layers while its card is in play (§10.4 layer 5). */
export type AuraHook = (ctx: { state: GameState; self: CardInstance; radiant: boolean }) => {
  /** Which units the aura touches. */
  applies: (unit: CardInstance) => boolean;
  mod: StatMod;
}[];

export type StaticFlags = {
  /** Plays itself on draw, then draws again (§6.2, R58). */
  castOnDraw?: boolean;
  /** Starts in the opening hand instead of a draw (§6.2). */
  quickdraw?: boolean;
  /** Replaces an empty-library draw with a Rush Token card (#75). */
  infiniteReserves?: boolean;
  /** Cannot switch to Defense Position (#65.1). */
  neverDefense?: boolean;
  /** R49: two exertions, so one attack plus one switch in a turn (#45 Deft Duelist). */
  deftDuelist?: boolean;
  /** R30: this card's own Echo, so its play resolves this many extra times. */
  echo?: number;
  /** Tribute cost in units, Sheep Tokens counting 2 (§6.3). */
  tribute?: number;
  /** R101: only a card that says so may pay its Tribute with the opponent's units (§8 #55). */
  tributeEnemies?: boolean;
  /** Anti-oneshot Armor: caps each hit on this player's hero at ANTI_ONESHOT_CAP (§4.4 step 3). */
  antiOneshot?: boolean;
  /**
   * #84 Going Long: while this card is in a backrow it gives that hero Armor from `HERO_ARMOR`,
   * picked by the instance's own `radiant` and `embiggened`, and §4.4 step 2 subtracts it. R124:
   * several sources add up, so this is a layer and not a value — a card carrying its own numbers
   * would put rules constants in a card file, which BUILD §2 keeps in `config.ts`.
   */
  heroArmor?: boolean;
};

export type Script = {
  /** Ceaseless Void's computed cost (R55); everything else uses the printed cost. */
  cost?: (args: { state: GameState; instance: CardInstance }) => number;
  cry?: Hook;
  death?: Hook;
  /** After the mulligan, before turn 1: only Heroic Power uses it (§6.2, R43). */
  startOfGame?: Hook;
  /** Named continuations a prompt answer re-enters (§10.6, R81). */
  resume?: Record<string, Hook>;
  /** A delayed effect this card scheduled, resolved at its R62 point. */
  delayed?: Hook;
  /** §10.4 layer 2: a card that sets its own stats from the board (#92 Felinor Fiender, R39). */
  setStat?: (args: { state: GameState; self: CardInstance; radiant: boolean }) => {
    attack?: number;
    maxHealth?: number;
  };
  startOfTurn?: Hook;
  endOfTurn?: Hook;
  aura?: AuraHook;
  triggers?: TriggerDef[];
  activate?: Hook;
  onPlayHook?: Hook;
  handTriggers?: TriggerDef[];
  staticFlags?: StaticFlags;
  /** The play-time choices this card declares (R81). */
  targets?: TargetDecl[];
  modes?: ModeDecl[];
};

export type CardScripts = { base: Script; radiant: Script };

export const EMPTY_SCRIPT: Script = {};
