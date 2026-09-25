// The card-script contract (SPEC §10.9). A card file returns Effect[] from the effects library and
// never touches state itself (CLAUDE.md rule 5); the engine applies the effects.

import type { GameEvent, Keyword, ModeDecl, PlayerId, PreviewValue, Selection, TargetDecl } from "@jackioh/shared";
import type { Rng } from "./rng";
import type { CardInstance, GameState } from "./state";
import type { EventStay } from "./stays";

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
   * new window on the action it resumes in; what the list did before the pause is `summoned`.
   *
   * Optional only because `packages/engine/test/pauses.test.ts` (line 227) hand-builds a context
   * literal instead of calling `makeContext`, and a test is not this task's to edit. Every engine
   * path builds its context through `makeContext`, which always sets it; absent it reads as 0 —
   * the whole action, the pre-R136 reading — and each reader spells that default out at the point
   * it slices. Once that literal is allowed to change this becomes required.
   */
  eventsFrom: number;
  /**
   * R174: the field's departures when this script's run began (`stays.exitMark`), so an effect later
   * in the list can tell a card an earlier one took off the field from the card that stood there
   * when the run began — across a prompt too, since a paused list resumes with the mark it began
   * with (`work.PausedStep.exitsFrom`). Set by `makeContext`; absent reads as "now".
   */
  exitsFrom?: number;
  /**
   * R174, §10.6: the field's departures when `targets` were chosen, where that is later than the
   * run began — the answer to this run's own prompt, picked as the prompt offered the board. A card
   * the list took off the field before it asked, and that stood there again when the prompt offered
   * it (a Reborn body, R83), is picked on that new stay, and the answered step's effect lands on it.
   * Absent reads as `exitsFrom`: a play's declared targets were chosen as its run began.
   */
  chosenFrom?: number;
  /**
   * R174, R212: the cards the event a queued trigger answers names, and the field's departures when
   * that event happened (`stays.eventStayOf`). The loop hands the trigger its event some time
   * later, so a card the event names is judged from then: a trigger that reads the played unit's id
   * off its `cardPlayed` does not land on the Reborn body an earlier trigger on the same event made
   * (R59). Every other card the run aims at is judged from `exitsFrom`, when the run began. Carried
   * across a pause with the run's other marks. Absent for any run that is not a queued trigger's.
   */
  eventStay?: EventStay;
  /**
   * R136: the units this script's run summoned in the actions before a prompt split it. The window
   * `eventsFrom` opens is the action's own event list, and a list the answer continues resumes in a
   * later action, so what its head summoned is carried here (`work.PausedStep.summoned`,
   * `work.RunMarks`). Absent for a run that has not paused.
   */
  summoned?: readonly string[];
  /**
   * R98: the card running the script sat in the resolving zone as the run began (§10.5 step 4) — a
   * Spell resolving, or a permanent that found no zone. The run is that card's while it stays there,
   * so a continuation re-entered once the card has left it — the Spell's own list put it back in its
   * owner's hand before it asked — resumes with no self (`prompts.runResume`). Carried across a pause
   * with the run's other marks (`work.RunMarks`, `work.PausedStep`). Absent for any other card.
   */
  selfResolving?: boolean;
  /** Who is resolving this: the controller of `self`, or the player who cast the card. */
  controller: PlayerId;
  /** The instance whose script is running, when it still exists. */
  self: CardInstance | null;
  /**
   * R127: the definition whose script is running, set where a continuation is re-entered
   * (`prompts.runResume`), because `self` is null once the card has ceased to exist and a step that
   * asks again must still name its script. Absent elsewhere, where `self` names it.
   */
  defId?: string;
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
   * A part of a composed list, built when the list reaches it: a fused hook runs each ingredient's
   * list in turn (R77, R102), and a later ingredient's list reads the board the earlier ones left
   * (#68's threshold after Reno's heal, #22's meal after #100's exile), which a list built all at
   * once cannot. `prompts.applyResumable` runs the part it builds as a nested list, so a prompt
   * inside it pauses the part and everything after it, and the pause records where it stood
   * (`work.PausedStep.part`) — so the part is built again on resume, and only the part the pause
   * stood in. `memo` is what the first build must hand every rebuild so the part is the same one:
   * #95's roll, which must not be rolled again (R87). A caller that only calls `apply` gets the
   * part built and applied in one go, as `resolve.lazyPart` writes it.
   */
  readonly expand?: (ctx: EffectContext, memo: unknown) => EffectPart;
};

/** What a part of a composed list builds (`Effect.expand`): its effects, and what a rebuild reads. */
export type EffectPart = { effects: readonly Effect[]; memo?: unknown };

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
  /**
   * #38: while on the field, its controller's cards gain "Combo X: deal X damage to the enemy hero"
   * (radiant 2X, dealt as one hit, R281). A number is how many times the card grants it: a card
   * fused from two Quickstrikers carries both texts (R102), and `true` is once. The multiple of X
   * each grant deals is not the flag's: it is `QUICKSTRIKER_COMBO_MULTIPLE` in `config.ts`, picked by
   * the granting instance's own face, as #84's Armor is (`HERO_ARMOR`), so a base and a Radiant
   * Quickstriker side by side deal X and then 2X.
   */
  quickstriker?: boolean | number;
  /**
   * #64 Gifted Program: while on the field, the first card costing this much or less its controller
   * plays each turn becomes Radiant as it is played (§10.5 step 3, R56, R213).
   */
  giftedProgram?: number;
  /** Tribute cost in units, Sheep Tokens counting 2 (§6.3). */
  tribute?: number;
  /**
   * §3.2, §7: what this unit counts toward a Tribute while it is on the field — the Sheep Token's
   * "worth 2 Tributes" (3 on its radiant face). Absent is 1. It is the face's text, so a Vanilla
   * unit is worth 1, and a fused card takes the larger of its ingredients' (R102).
   */
  tributeWorth?: number;
  /** R101: only a card that says so may pay its Tribute with the opponent's units (§8 #55). */
  tributeEnemies?: boolean;
  /** Anti-oneshot Armor: caps each hit on this player's hero at ANTI_ONESHOT_CAP (§4.4 step 3). */
  antiOneshot?: boolean;
  /**
   * #84 Going Long: while this card is in a backrow it gives that hero Armor from `HERO_ARMOR`,
   * picked by the instance's own `radiant` and `embiggened`, and §4.4 step 2 subtracts it. R124:
   * several sources add up, so this is a layer and not a value — a card carrying its own numbers
   * would put rules constants in a card file, which BUILD §2 keeps in `config.ts`. A card fused from
   * two carries both grants (R102), so a fused face may hold a count.
   */
  heroArmor?: boolean | number;
};

/** R195, R280: where `viewFor` is asking about a card. */
export type ConditionZone = "hand" | "field";

/**
 * R195, R280, §10.9: the argument of the two read-only hooks `viewFor` asks, the Hearthstone "yellow
 * glow" predicate (`conditionMet`) and the number a formula comes to now (`preview`). A hook is a
 * PURE READ — it never writes, never draws from `rng` (the context carries none), never returns
 * effects — and must agree with what the card's own resolution would do if it resolved now.
 */
export type ConditionContext = {
  state: GameState;
  self: CardInstance;
  /**
   * The card's controller. R195 only ever asks about the viewer's own cards, so there this is the
   * viewer; R280 asks about any card the viewer may read, the other seat's public ones included, so
   * there it is the card's controller and never the viewer as such.
   */
  controller: PlayerId;
  /** Whether the Radiant face is the one running (§5.2). */
  radiant: boolean;
  /** "hand": as if played now. "field": as the card on the field reads it now. */
  zone: ConditionZone;
  /** `state.active === controller`, so a card file never reads `state.active` itself. */
  yourTurn: boolean;
};

export type ConditionHook = (ctx: ConditionContext) => boolean;

/**
 * R280, §10.9: the labelled numbers a card's formula comes to now — #31's Fib(cost+1), #70's sum
 * over missing health and exile. Each `label` is the formula as the running face prints it, an
 * exact substring of that face's catalog text (the client prints the value in braces right after
 * the label's first occurrence, §10.10), and each `value` what it would come to if the card resolved
 * now. The hook is asked with the same context `conditionMet` is (the running face, the card's
 * controller, the zone, `yourTurn`) and is a PURE READ, built on the same function the card's own
 * resolution computes the number with, so the two cannot disagree. It reads only what the card's
 * controller may read (§9.1) — a hero's health, a pile's size, the plays this turn, its own cost and
 * counters — never a library's contents or order or a hidden hand, because `viewFor` shows the
 * result to every viewer who may read the card, the other seat included (`preview.ts`). An empty
 * list is no preview at all.
 */
export type PreviewHook = (ctx: ConditionContext) => PreviewValue[];

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
  /** R195: the condition `viewFor` surfaces as `conditionActive` (§10.8). */
  conditionMet?: ConditionHook;
  /** R280: the numbers the card's formula comes to now, which `viewFor` surfaces as `preview` (§10.8). */
  preview?: PreviewHook;
};

export type CardScripts = { base: Script; radiant: Script };

export const EMPTY_SCRIPT: Script = {};
