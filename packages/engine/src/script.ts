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
  /**
   * R136: where *this script's* events begin in `events`. The array is the whole action's sink, so
   * a card that asks "what did I just do" — #60 Bear Honeypot's "they attack it", and the same
   * shape in #24, #31, #33, #38 — must read `events.slice(eventsFrom)` and never the earlier
   * entries, or a second copy of a card, or a trap firing mid-action, feeds its condition. Set once
   * where the context is built (`resolve.makeContext`), so a step re-entered after a prompt opens a
   * new window rather than reviving the original one.
   *
   * Optional only because `packages/engine/test/pauses.test.ts` (line 227) hand-builds a context
   * literal instead of calling `makeContext`, and a test is not this task's to edit. Every engine
   * path builds its context through `makeContext`, which always sets it; absent it reads as 0 —
   * the whole action, the pre-R136 reading — and each reader spells that default out at the point
   * it slices. Once that literal is allowed to change this becomes required.
   */
  eventsFrom: number;
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
  /**
   * Which part of a composed list this effect came from: a fused hook runs every ingredient's list
   * (R77, R102), and tags each effect with its ingredient's index — a path, since a fused card can be
   * fused again. A pause records the parts' lengths, so the list rebuilt on resume is continued part
   * by part (`work.resumeIndex`, R113) even when a part rebuilt against the board it now finds is
   * shorter or longer than it was. A card's own effects carry none.
   */
  readonly segment?: readonly number[];
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
  /** R30, R209: the Echo this permanent's rider gives the next Spell, read off its face now (#79). */
  echoGrant?: number;
  /** #38: while on the field, its controller's cards gain "Combo X: X damage to the enemy hero". */
  quickstriker?: boolean;
  /**
   * #64 Gifted Program: while on the field, the first card costing this much or less its controller
   * plays each turn becomes Radiant as it is played (§10.5 step 3, R56, R213).
   */
  giftedProgram?: number;
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
