// Heroic Power (SPEC §8 #98, R43): the seven powers, the roll that picks one, the cost that is
// always the power's X, and the once-a-turn activation.
//
// R43 puts everything about the card on its instance: `memory.power` is the power it rolled and
// `memory.usedTurn` the turn it last used it. Nothing here is a module variable, so two Heroic
// Powers in one game never share a roll or a use, and a serialized game resumes knowing both
// (§10.1). The roll goes through the match rng, so a replay rolls the same power (§9.3).
//
// The card's cost is the power's X and the player never chooses it (R43, R65). That works through
// the ordinary cost pipeline: #98's script has a `cost` hook of `powerCostOf`, which `printedCost`
// reads ahead of the printed "X", so the play validator, `legalActions` and the client all see the
// same number without a special case for this card.
//
// Two powers pause. "Deal 1 damage to a target" takes a target, which R81 lets the `activatePower`
// action carry, and "Discover a Unit" is a prompt by definition (§6.3). Both are written as one
// builder that reads `ctx.targets`: with a selection it does the work, without one it opens the
// prompt and names `POWER_RESUME` as the step to come back to. The answer re-enters `heroPower`
// below with the selection in `ctx.targets`, which runs the same builder down its other branch —
// so a paused activation is a `PendingChoice` in state and never a callback (§9.3, §10.6).

import type { PlayerId, Selection } from "@jackioh/shared";
import { defByIndex } from "../catalog";
import {
  addToHand,
  chooseTarget,
  chosenOptions,
  damage,
  discoverFromCatalog,
  draw,
  loseHealth,
  recruit,
  summon,
  targetsInScope,
  type TargetScope,
} from "../effects";
import { manaEvent, spendMana } from "../mana";
import { applyEffects, makeContext, type EngineSink } from "../resolve";
import type { Effect, EffectContext, Hook } from "../script";
import { stateCheck } from "../stateCheck";
import { findInstance, type CardInstance, type GameState } from "../state";
import { paused as isPaused } from "../work";

/** R43: where the rolled power and its last use live on the instance. */
export const POWER_KEY = "power";
export const POWER_USED_KEY = "usedTurn";

/**
 * The resume step an activation that opened a prompt comes back to (§10.6). `prompts.ts` stores it
 * as the `step` of the `Resume` a prompt carries and looks the answer up in the card's own step
 * table (`RESUME_HOOK`), so #98's script wires the pair together in one line:
 *
 *     resume: { [POWER_RESUME]: heroPower }
 *
 * Nothing else in the engine needs to know about hero powers for a prompted power to work.
 */
export const POWER_RESUME = "heroPower";

/** The data key that names the power a paused activation is finishing. */
export const POWER_DATA_KEY = "power";

/** §8 #98: "lose 2 health, draw 1" — the health is a cost, so it is a loss, not damage (R18). */
export const POWER_HEALTH_COST = 2;

/** §7: the tokens #98 summons, by catalog index (§5.3), so the engine names no catalog id. */
export const RUSH_TOKEN_INDEX = "T-rush";
export const FELINOR_TOKEN_INDEX = "T-felinor";

/** "Deal 1 damage to a target": any unit or hero, either side. */
const PING_SCOPE: TargetScope = { side: "any", of: ["unit", "hero"] };

export type HeroPowerName = "recruit" | "draw" | "ping" | "burn" | "rush" | "felinor" | "discover";

export type HeroPower = {
  name: HeroPowerName;
  /** "Once per turn, spend X" (§8 #98): the X, which is also the card's cost (R43, R65). */
  x: number;
  /** The §8 #98 clause this entry implements, base form and radiant form. */
  label: string;
  radiantLabel: string;
  /** The effects one activation runs. `radiant` picks the radiant clause (§5.2). */
  build: (ctx: EffectContext, radiant: boolean) => Effect[];
};

function tokenDefId(index: string): string | null {
  return defByIndex(index)?.id ?? null;
}

/** §7: a token summon needs the token's def id, which the catalog holds under its index. */
function summonTokens(index: string, count: number): Effect[] {
  const defId = tokenDefId(index);
  if (defId === null) return [];
  return Array.from({ length: count }, () => summon({ defId }));
}

/**
 * R43: "'Recruit a card' recruits a permanent", which is what §6.3's Recruit already does — it
 * scans the library top down for the first Unit, Field Spell, Trap or Field Trap.
 */
function recruitEffects(_ctx: EffectContext, radiant: boolean): Effect[] {
  return [recruit({ radiant })];
}

function drawEffects(_ctx: EffectContext, radiant: boolean): Effect[] {
  return [
    loseHealth({ player: "self", amount: POWER_HEALTH_COST }),
    draw({ count: radiant ? 2 : 1 }),
  ];
}

/**
 * R81: a target named in the `activatePower` action arrives in `ctx.targets`, so the power deals
 * the damage at once. With no target named it opens the prompt instead and finishes when the
 * answer re-enters `heroPower`.
 */
function pingEffects(ctx: EffectContext, radiant: boolean): Effect[] {
  const amount = radiant ? 2 : 1;
  if (ctx.targets.length > 0) return [damage({ to: { of: "chosen" }, amount })];
  return [
    chooseTarget({
      step: POWER_RESUME,
      scope: PING_SCOPE,
      prompt: `Deal ${amount} damage to a target`,
      data: { [POWER_DATA_KEY]: "ping" },
    }),
  ];
}

/** §8 #98: "deal 2 damage to each opposing hero"; two players, so that is the one enemy hero. */
function burnEffects(_ctx: EffectContext, radiant: boolean): Effect[] {
  return [damage({ to: { of: "enemyHero" }, amount: radiant ? 4 : 2 })];
}

function rushEffects(_ctx: EffectContext, radiant: boolean): Effect[] {
  return summonTokens(RUSH_TOKEN_INDEX, radiant ? 2 : 1);
}

function felinorEffects(_ctx: EffectContext, radiant: boolean): Effect[] {
  return summonTokens(FELINOR_TOKEN_INDEX, radiant ? 2 : 1);
}

/**
 * §6.3 Discover: 1 of 3 Units, shown only to the chooser. The pick comes back as a mode selection
 * carrying a def id, and the Unit goes to hand — Radiant when the power is (§8 #98 radiant).
 */
function discoverEffects(ctx: EffectContext, radiant: boolean): Effect[] {
  const picked = chosenOptions(ctx)[0];
  if (picked !== undefined) return [addToHand({ defId: picked, player: "self", radiant })];
  return [
    discoverFromCatalog({
      step: POWER_RESUME,
      query: { type: "Unit" },
      prompt: radiant ? "Discover a Radiant Unit" : "Discover a Unit",
      data: { [POWER_DATA_KEY]: "discover" },
    }),
  ];
}

/** The seven powers of §8 #98, in the order the card lists them. */
export const HERO_POWERS: readonly HeroPower[] = [
  {
    name: "recruit",
    x: 3,
    label: "Recruit a permanent",
    radiantLabel: "Recruit a permanent and make it Radiant",
    build: recruitEffects,
  },
  {
    name: "draw",
    x: 1,
    label: "Lose 2 health, draw 1",
    radiantLabel: "Lose 2 health, draw 2",
    build: drawEffects,
  },
  {
    name: "ping",
    x: 1,
    label: "Deal 1 damage to a target",
    radiantLabel: "Deal 2 damage to a target",
    build: pingEffects,
  },
  {
    name: "burn",
    x: 1,
    label: "Deal 2 damage to each opposing hero",
    radiantLabel: "Deal 4 damage to each opposing hero",
    build: burnEffects,
  },
  {
    name: "rush",
    x: 2,
    label: "Summon a Rush Token",
    radiantLabel: "Summon two Rush Tokens",
    build: rushEffects,
  },
  {
    name: "felinor",
    x: 1,
    label: "Summon a Felinor Token",
    radiantLabel: "Summon two Felinor Tokens",
    build: felinorEffects,
  },
  {
    name: "discover",
    x: 2,
    label: "Discover a Unit",
    radiantLabel: "Discover a Radiant Unit",
    build: discoverEffects,
  },
];

export const HERO_POWER_NAMES: readonly HeroPowerName[] = HERO_POWERS.map((power) => power.name);

export function powerByName(name: string): HeroPower | null {
  return HERO_POWERS.find((power) => power.name === name) ?? null;
}

// ---------------------------------------------------------------------------
// The power on the instance (R43).
// ---------------------------------------------------------------------------

/** The power this card rolled, or null for a card that has not rolled one yet. */
export function powerOf(instance: CardInstance): HeroPower | null {
  const name = instance.memory[POWER_KEY];
  return typeof name === "string" ? powerByName(name) : null;
}

/**
 * R43: "Its cost is always the power's X, never chosen by the player". #98's `cost` hook is this
 * function, so `printedCost` reports it and `effectiveCost` builds on it (R65). A card that has not
 * rolled yet has no X to report and costs 0; R43 rolls one as it arrives in a hand or library, so
 * the only cards in that state are ones no player can play.
 */
export function powerCostOf(instance: CardInstance): number {
  return powerOf(instance)?.x ?? 0;
}

/**
 * R43's roll: a Heroic Power that has no power picks one from the match rng and remembers it, and
 * one that already has a power keeps it. #98 calls this from `startOfGame` for every copy in a hand
 * or library (§6.2), and again whenever a copy arrives somewhere without one — a bounced or reset
 * instance (R78) — which is why it is idempotent rather than a plain roll.
 */
export function ensurePower(sink: EngineSink, instance: CardInstance): HeroPower | null {
  const existing = powerOf(instance);
  if (existing !== null) return existing;
  const rolled = sink.rng.pick(HERO_POWERS);
  if (rolled === undefined) return null;
  instance.memory[POWER_KEY] = rolled.name;
  return rolled;
}

export function usedThisTurn(state: GameState, instance: CardInstance): boolean {
  return instance.memory[POWER_USED_KEY] === state.turn;
}

function markPowerUsed(state: GameState, instance: CardInstance): void {
  instance.memory[POWER_USED_KEY] = state.turn;
}

function sinkOf(ctx: EffectContext): EngineSink {
  return { state: ctx.state, events: ctx.events, rng: ctx.rng };
}

function cardOf(ctx: EffectContext, instanceId?: string): CardInstance | null {
  if (instanceId === undefined) return ctx.self;
  return findInstance(ctx.state, instanceId) ?? null;
}

// ---------------------------------------------------------------------------
// Activating it (R43).
// ---------------------------------------------------------------------------

/**
 * R43's roll as an effect, so #98's `startOfGame` hook is a list of effects like every other card's
 * (CLAUDE.md rule 5).
 */
export function rollPower(args: { instanceId?: string } = {}): Effect {
  return {
    kind: "rollPower",
    apply(ctx): void {
      const card = cardOf(ctx, args.instanceId);
      if (card === null) return;
      ensurePower(sinkOf(ctx), card);
    },
  };
}

/**
 * One activation of the power, and this turn's use (R43). Playing the card returns this from its
 * Cry — "Playing it pays X and activates the power once, which is that turn's use" — and the
 * `activatePower` action runs the same effect afterwards.
 *
 * The use is marked before the effects run, so a power that pauses on a prompt has already spent
 * the turn's activation and the answer cannot buy a second one. No power's list has an effect after
 * the one that opens its prompt, which is why this applies the list directly; a power that ever
 * needs one would have to go through `prompts.applyResumable` to park its tail (§9.3).
 */
export function usePower(args: { instanceId?: string; radiant?: boolean } = {}): Effect {
  return {
    kind: "usePower",
    apply(ctx): void {
      const card = cardOf(ctx, args.instanceId);
      if (card === null) return;
      const power = ensurePower(sinkOf(ctx), card);
      if (power === null) return;

      const radiant = args.radiant ?? card.radiant;
      markPowerUsed(ctx.state, card);
      const powerCtx: EffectContext = { ...ctx, self: card, radiant };
      applyEffects(power.build(powerCtx, radiant), powerCtx);
    },
  };
}

/**
 * The continuation an answered prompt comes back to: `prompts.ts` re-enters the step the prompt's
 * `Resume` names — `POWER_RESUME`, which #98's `resume` table points here — with the selection
 * already in `ctx.targets` (§10.6). The power's own builder finishes the activation, so the
 * prompted and the unprompted path are one piece of code.
 */
export const heroPower: Hook = (ctx) => {
  const named = ctx.data[POWER_DATA_KEY];
  const power = (typeof named === "string" ? powerByName(named) : null) ?? (ctx.self === null ? null : powerOf(ctx.self));
  if (power === null) return [];
  return power.build(ctx, ctx.self?.radiant ?? ctx.radiant);
};

/**
 * Why this player cannot activate that power right now, or null when they can. `legalActions` and
 * the reducer share it, so the greyed-out button and the rejected action give one reason (§10.2).
 *
 * R43's once per turn is checked ahead of the mana and the phase: it is the rule that belongs to
 * the card rather than to the player's turn, and it is the reason a player needs to hear.
 */
export function whyCannotActivate(state: GameState, player: PlayerId, instanceId: string): string | null {
  const card = findInstance(state, instanceId);
  if (card === undefined) return `no card ${instanceId}`;
  if (card.controller !== player) return "that card is not yours";
  if (card.zone.z !== "field") return "that card is not on the field";

  const power = powerOf(card);
  if (power === null) return "that card has no power";
  if (usedThisTurn(state, card)) return "that power has already been used this turn";

  if (state.result !== null) return "the game is over";
  if (state.pending !== null) return "answer the open prompt first";
  if (state.active !== player) return "it is not your turn";
  if (state.phase !== "main") return "a power is activated in the main phase";
  if (power.x > state.players[player].mana.current) {
    return `that power costs ${power.x}, more than your mana`;
  }
  return null;
}

/**
 * §9.3 "reduce refuses illegal actions itself", for what an `activatePower` carries. R103 lets the
 * action name one thing: the ping's target, which must be a target the ping could reach — a unit on
 * the field (never one dormant under a Stack, R13, nor a card in a hand or the backrow) or a hero,
 * exactly what the prompt would have offered (`PING_SCOPE`). Every other power takes nothing, so a
 * selection sent with one is refused rather than read — above all a Discover's answer, which only
 * the Discover's own prompt may carry (§6.3: its options are drawn by the engine, not named by the
 * client).
 */
function whyTargetsRefused(
  sink: EngineSink,
  player: PlayerId,
  card: CardInstance,
  targets: readonly Selection[],
): string | null {
  if (targets.length === 0) return null;
  if (powerOf(card)?.name !== "ping") return "that power takes no target";
  if (targets.length > 1) return "that power takes one target";
  const [pick] = targets;
  const legal = targetsInScope(makeContext(sink, card, { controller: player }), PING_SCOPE);
  const reachable = legal.some(
    (option) =>
      (option.pick === "instance" && pick?.pick === "instance" && option.instanceId === pick.instanceId) ||
      (option.pick === "hero" && pick?.pick === "hero" && option.player === pick.player),
  );
  return reachable ? null : "that is not a target the power can reach";
}

/**
 * The `activatePower` action of §10.2: validate, spend the power's X, activate it once. The targets
 * the action carried travel into the activation as the play's selections do (R81), so a power that
 * needs one takes it from there instead of opening a prompt.
 */
export function activatePower(
  sink: EngineSink,
  player: PlayerId,
  args: { instanceId: string; targets?: readonly Selection[] },
): string | null {
  const why = whyCannotActivate(sink.state, player, args.instanceId);
  if (why !== null) return why;

  const card = findInstance(sink.state, args.instanceId);
  if (card === undefined) return `no card ${args.instanceId}`;

  const refused = whyTargetsRefused(sink, player, card, args.targets ?? []);
  if (refused !== null) return refused;

  const side = sink.state.players[player];
  spendMana(side, powerCostOf(card));
  sink.events.push(manaEvent(player, side));

  const ctx = makeContext(sink, card, { controller: player, targets: [...(args.targets ?? [])] });
  applyEffects([usePower({ instanceId: card.id })], ctx);
  // R59: the check follows the whole power. One whose draw cast a card that is still asking is not
  // whole yet — the unit the cast brought to 0 is on the field where its prompt offered it — and the
  // answer's own check finishes it (§2.4's chain checks after each cast, R156).
  if (!isPaused(sink)) stateCheck(sink);
  return null;
}
