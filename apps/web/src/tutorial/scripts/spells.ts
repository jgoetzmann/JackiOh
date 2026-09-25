// Lesson "spells"'s coach script (SPEC §9.10): the steps the coach walks the player through, and the
// tips it shows when something new happens. Written against this lesson's fixed seed and decks
// (lessons/spells.ts), so it may name the cards the seed deals.
//
// The seed deals the player Tempo Timmy, Mr. Vanilla and Twisted Sorcerer, then draws Lunar Eclipse,
// Deft Duelist, True Strike, Hit Job and Big D-fender in that order; the AI opens with Me and Mr
// Token, The Coin and Right-house defender (Taunt, Divine Shield, Reborn). The coach line:
//
//   turn 1  Mr. Vanilla; read a card; end the turn.
//   turn 2  Mr. Vanilla attacks the Taunt, and its Divine Shield breaks; Lunar Eclipse finishes the
//           defender, and Reborn brings it back; Tempo Timmy arrives and attacks at once (Rush).
//   turn 3  Twisted Sorcerer's Cry and True Strike (which ignores Armor) destroy the AI's Archivist in
//           Defense; Tempo Timmy's First Strike finishes the defender; Mr. Vanilla hits the hero.
//   turn 4  Hit Job destroys the biggest Taunt, Twisted Sorcerer the other; Deft Duelist charges the
//           hero the turn it arrives, and the rest follow.
//   turn 5  Big D-fender goes to Defense Position; then the last step until the enemy hero falls.
//
// Every step belongs to one of the player's turns (`onTurn`), reads only the view and the legal
// actions (CLAUDE.md rule 7), and retires without a word once its moment has passed, so a player who
// does things their own way is never asked for something that can no longer happen. The tips
// answer what the AI does, whenever it does it.

import type { ActionBody, PlayerView, Selection, UnitView } from "@jackioh/shared";

import type { CoachCtx, CoachStep, LessonScript } from "../coach.ts";
import {
  attackWith,
  endTurn,
  freshOf,
  heroTargetId,
  info,
  inHand,
  keepHand,
  myMain,
  myTurnNumber,
  playCard,
  switchPosition,
  tip,
  unitOf,
  unitsOf,
} from "../steps.ts";

const VANILLA = "core-008";
const TIMMY = "core-011";
const LUNAR = "core-035";
const TRUE_STRIKE = "core-044";
const SORCERER = "core-068";
const DUELIST = "core-045";
const BIG_D = "core-001";
const HIT_JOB = "core-016";
const DEFENDER = "core-003";
const SEVEN = "core-025";
const JILLIAX = "core-056";
const COIN = "core-t-coin";

/** The damage the lesson's damage cards print (§8: #35, #44, #68), which the coach aims and says. */
const LUNAR_DAMAGE = 3;
const TRUE_STRIKE_DAMAGE = 4;
const SORCERER_DAMAGE = 4;

/** The units a step may name, both decks' (and the Rush Token Me and Mr Token summons). */
const NAMES: Readonly<Record<string, string>> = {
  "core-001": "Big D-fender",
  "core-003": "Right-house defender",
  "core-008": "Mr. Vanilla",
  "core-011": "Tempo Timmy",
  "core-012": "Duplicating Felinors",
  "core-013": "Jlockeed Shredder-10",
  "core-015": "Me and Mr Token",
  "core-019": "Midrange Menace",
  "core-020": "Pointmaster",
  "core-025": "4-mana 7/7",
  "core-030": "Archivist",
  "core-032": "Prem Panther",
  "core-037": "Gravedigger",
  "core-045": "Deft Duelist",
  "core-053": "Reno",
  "core-056": "Jilliax",
  "core-068": "Twisted Sorcerer",
  "core-077": "Professor Curvature",
  "core-t-rush": "the Rush Token",
};

// ---------------------------------------------------------------------------------------------
// reads of the view this lesson needs
// ---------------------------------------------------------------------------------------------

function hasKeyword(unit: UnitView, kind: string): boolean {
  return unit.keywords.some((keyword) => keyword.kind === kind);
}

/** The AI's units that carry Taunt, printed or from Defense Position. */
function enemyTaunts(view: PlayerView): UnitView[] {
  return unitsOf(view, "opponent").filter((unit) => hasKeyword(unit, "Taunt"));
}

/**
 * The human's unit of this definition arrived this turn, as far as the view's recent events reach
 * (`PlayerView.events`): its `summoned` comes after the turn's `turnStarted`. The Rush and Charge
 * steps ask for an attack "the turn it arrives", so they say so only when it did.
 */
function arrivedThisTurn(view: PlayerView, defId: string): boolean {
  const unit = unitOf(view, "you", defId);
  if (unit === undefined) return false;
  for (let index = view.events.length - 1; index >= 0; index -= 1) {
    const event = view.events[index];
    if (event?.type === "summoned" && event.instanceId === unit.instanceId) return true;
    if (event?.type === "turnStarted") return false;
  }
  return false;
}

function enemyName(view: PlayerView, instanceId: string): string {
  const unit = unitsOf(view, "opponent").find((candidate) => candidate.instanceId === instanceId);
  return unit === undefined ? "that unit" : (NAMES[unit.defId] ?? "that unit");
}

// ---------------------------------------------------------------------------------------------
// aiming a spell or a Cry
// ---------------------------------------------------------------------------------------------

/** What a step asks the player to aim at: a selection its play action carries (R81). */
type Aim = (ctx: CoachCtx) => Selection | null;

function sameSelection(a: Selection, b: Selection): boolean {
  if (a.pick === "instance" && b.pick === "instance") return a.instanceId === b.instanceId;
  if (a.pick === "hero" && b.pick === "hero") return a.player === b.player;
  return false;
}

function byValue(a: UnitView, b: UnitView): number {
  return b.attack + b.health - (a.attack + a.health);
}

/**
 * Where `damage` is best spent: an enemy unit it destroys outright — a Taunt first, as it stands in
 * the way, then the biggest — never one whose Divine Shield would soak it all; else the biggest
 * enemy unit it can hurt; else the enemy hero. `ignoresArmor` is True Strike's text.
 */
function damageAim(damage: number, ignoresArmor = false): Aim {
  return (ctx) => {
    const dealt = (unit: UnitView): number => (ignoresArmor ? damage : Math.max(0, damage - unit.armor));
    const open = unitsOf(ctx.view, "opponent").filter((unit) => !hasKeyword(unit, "Divine Shield") && dealt(unit) > 0);
    const kills = open.filter((unit) => unit.health <= dealt(unit));
    kills.sort((a, b) => Number(hasKeyword(b, "Taunt")) - Number(hasKeyword(a, "Taunt")) || byValue(a, b));
    const target = kills[0] ?? [...open].sort(byValue)[0];
    return target === undefined ? { pick: "hero", player: ctx.view.opponent.player } : { pick: "instance", instanceId: target.instanceId };
  };
}

/** The biggest enemy unit with no Divine Shield to soak a hit; else the enemy hero. */
function biggestOpen(ctx: CoachCtx): Selection | null {
  const target = unitsOf(ctx.view, "opponent")
    .filter((unit) => !hasKeyword(unit, "Divine Shield"))
    .sort(byValue)[0];
  return target === undefined ? { pick: "hero", player: ctx.view.opponent.player } : { pick: "instance", instanceId: target.instanceId };
}

/** The enemy unit most worth destroying: the biggest on the board. */
function biggestEnemy(ctx: CoachCtx): Selection | null {
  const target = [...unitsOf(ctx.view, "opponent")].sort(byValue)[0];
  return target === undefined ? null : { pick: "instance", instanceId: target.instanceId };
}

function aimName(ctx: CoachCtx, aim: Aim): string {
  const target = aim(ctx);
  if (target?.pick === "hero") return "the enemy hero";
  if (target?.pick === "instance") return enemyName(ctx.view, target.instanceId);
  return "an enemy";
}

type Common = {
  id: string;
  title: string;
  text: CoachStep["text"];
  when?: (ctx: CoachCtx) => boolean;
  anchor?: CoachStep["anchor"];
  holdAi?: boolean;
};

/**
 * "Play this card at that target": a targeted spell, or a unit whose Cry takes a target (§6.2:
 * targets are chosen at play time). Shows while the engine offers that play at that target; done
 * once the card has left the hand; moot if it is gone before the step ever showed.
 */
function playAt(options: Common & { defId: string; aim: Aim }): CoachStep {
  const { defId, aim, when, ...rest } = options;
  const matches = (action: ActionBody, ctx: CoachCtx): boolean => {
    const card = inHand(ctx.view, defId);
    const target = aim(ctx);
    if (card === undefined || target === null || action.type !== "play" || action.instanceId !== card.instanceId) return false;
    return (action.targets ?? []).some((selection) => sameSelection(selection, target));
  };
  return {
    kind: "act",
    anchor: { kind: "handCard", defId },
    ...rest,
    when: (ctx) => myMain(ctx) && ctx.legal.some((action) => matches(action, ctx)) && (when === undefined || when(ctx)),
    done: (ctx) => inHand(ctx.view, defId) === undefined,
    moot: (ctx, since) => since === null && inHand(ctx.view, defId) === undefined,
    expect: matches,
  };
}

/**
 * This step belongs to the player's own turn `n`: it may show only then, and it retires without a
 * word once that turn has passed. Before that turn's main phase it waits, so a step about a card
 * still to be drawn waits for the draw. From then on, a step that cannot show when its moment comes
 * never will (the card has gone, the mana is spent, the unit that was to attack is not there), so
 * it retires at once rather than hold back the steps behind it; and an `act` step already showing
 * retires the same way once what it asks is no longer on offer (the coach checks `done` first, so a
 * step the player has just done is done, not moot). A player who does things their own way meets
 * the next step that still makes sense.
 */
function onTurn(n: number, step: CoachStep): CoachStep {
  const ownWhen = step.when;
  const ownMoot = step.moot;
  const showable = (ctx: CoachCtx): boolean => ownWhen === undefined || ownWhen(ctx);
  return {
    ...step,
    when: (ctx) => myTurnNumber(ctx.view) === n && showable(ctx),
    moot: (ctx, since) => {
      const turn = myTurnNumber(ctx.view);
      if (turn > n) return true;
      if (turn < n || !myMain(ctx)) return false;
      if (ownMoot !== undefined && ownMoot(ctx, since)) return true;
      return (since === null || step.kind === "act") && !showable(ctx);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// suggesting an attack
// ---------------------------------------------------------------------------------------------

type Attack = Extract<ActionBody, { type: "attack" }>;

function isAttack(action: ActionBody): action is Attack {
  return action.type === "attack";
}

/** One blow as the view shows it: a Divine Shield soaks it whole, Armor lessens it (§4.4 steps 1–2). */
function blow(amount: number, target: UnitView): number {
  if (amount <= 0 || hasKeyword(target, "Divine Shield")) return 0;
  return Math.max(0, amount - target.armor);
}

/**
 * What the board suggests an attack on a unit comes to (§4.3): whether the defender falls, and
 * whether the attacker lives through its answer. Advice only, read off the view: the engine alone
 * resolves the attack.
 */
function outcome(view: PlayerView, attack: Attack): { kills: boolean; survives: boolean } | null {
  const attacker = unitsOf(view, "you").find((unit) => unit.instanceId === attack.attackerId);
  const defender = unitsOf(view, "opponent").find((unit) => unit.instanceId === attack.targetId);
  if (attacker === undefined || defender === undefined) return null;
  const kills = blow(attacker.attack, defender) >= defender.health;
  const strikesFirst = hasKeyword(attacker, "First Strike") && !hasKeyword(defender, "First Strike");
  const back = kills && strikesFirst ? 0 : blow(defender.attack, attacker);
  return { kills, survives: back < attacker.health };
}

/**
 * The attack the coach suggests next, among the ones the engine offers: the enemy hero whenever it
 * may be attacked; else a blow that destroys the unit in the way (a Taunt, since only a Taunt can
 * keep the hero out), one the attacker survives first; else none.
 */
function goodAttack(ctx: CoachCtx): Attack | undefined {
  const attacks = ctx.legal.filter(isAttack);
  const hero = heroTargetId(ctx.view, "opponent");
  const face = attacks.find((attack) => attack.targetId === hero);
  if (face !== undefined) return face;
  const killing = attacks
    .map((attack) => ({ attack, result: outcome(ctx.view, attack) }))
    .filter((entry) => entry.result?.kills === true);
  killing.sort((a, b) => Number(b.result?.survives) - Number(a.result?.survives));
  return killing[0]?.attack;
}

/** An "End your turn" text that first says to attack when the board still offers a good attack. */
function endTurnText(settled: string): (ctx: CoachCtx) => string {
  return (ctx) => (goodAttack(ctx) === undefined ? settled : "Attack with what can still attack, then press End turn.");
}

function unitName(view: PlayerView, instanceId: string): string {
  const unit = [...unitsOf(view, "you"), ...unitsOf(view, "opponent")].find((candidate) => candidate.instanceId === instanceId);
  return unit === undefined ? "that unit" : (NAMES[unit.defId] ?? "that unit");
}

/**
 * "Attack well": the coach suggests one good attack at a time (`goodAttack`). With `clearing`, only
 * while an enemy Taunt still stands, and done once none does; otherwise until no good attack is
 * left. Done, either way, once the turn has passed.
 */
function attackWell(options: Common & { clearing?: boolean }): CoachStep {
  const { when, clearing = false, ...rest } = options;
  const blocked = (ctx: CoachCtx): boolean => enemyTaunts(ctx.view).length > 0;
  return {
    kind: "act",
    anchor: (ctx) => {
      const attack = goodAttack(ctx);
      const unit = attack === undefined ? undefined : unitsOf(ctx.view, "you").find((candidate) => candidate.instanceId === attack.attackerId);
      return unit === undefined ? { kind: "units", side: "you" } : { kind: "unit", side: "you", defId: unit.defId };
    },
    ...rest,
    when: (ctx) => myMain(ctx) && goodAttack(ctx) !== undefined && (!clearing || blocked(ctx)) && (when === undefined || when(ctx)),
    // Clearing the way is moot once nothing blocks it.
    moot: (ctx, since) => clearing && since === null && myMain(ctx) && !blocked(ctx),
    done: (ctx, since) => {
      if (ctx.view.turn !== since.turn) return true;
      if (clearing) return !blocked(ctx);
      return myMain(ctx) && goodAttack(ctx) === undefined;
    },
    expect: (action, ctx) => {
      const best = goodAttack(ctx);
      return best !== undefined && isAttack(action) && action.attackerId === best.attackerId && action.targetId === best.targetId;
    },
  };
}

/** What `attackWell` says about the attack it suggests now. */
function attackAdvice(ctx: CoachCtx): string {
  const attack = goodAttack(ctx);
  if (attack === undefined) return "Attack with the units that can.";
  const attacker = unitName(ctx.view, attack.attackerId);
  if (attack.targetId === heroTargetId(ctx.view, "opponent")) return `Nothing guards the enemy hero now: attack it with ${attacker}.`;
  return `The AI's ${unitName(ctx.view, attack.targetId)} has Taunt and blocks the way. ${attacker} can destroy it: attack it.`;
}

// ---------------------------------------------------------------------------------------------
// the last step: every move until the enemy hero falls
// ---------------------------------------------------------------------------------------------

type Play = Extract<ActionBody, { type: "play" }>;

/** A play aimed at one of the human's own cards or their own hero. */
function aimsAtOwnSide(ctx: CoachCtx, play: Play): boolean {
  const own = new Set(unitsOf(ctx.view, "you").map((unit) => unit.instanceId));
  return (play.targets ?? []).some(
    (target) => (target.pick === "instance" && own.has(target.instanceId)) || (target.pick === "hero" && target.player === ctx.view.viewer),
  );
}

/** The dearest card the human can play now, aimed away from their own side. */
function bestPlay(ctx: CoachCtx): Play | undefined {
  const hand = Array.isArray(ctx.view.you.hand) ? ctx.view.you.hand : [];
  const costOf = (instanceId: string): number => hand.find((card) => card.instanceId === instanceId)?.cost ?? 0;
  const plays = ctx.legal.filter((action): action is Play => action.type === "play" && !aimsAtOwnSide(ctx, action));
  plays.sort((a, b) => costOf(b.instanceId) - costOf(a.instanceId));
  return plays[0];
}

/**
 * With a Taunt keeping the hero out of reach and no blow that destroys it, the hit that wears it
 * down most while the attacker lives: damage stays, so the next hit finishes it.
 */
function chip(ctx: CoachCtx): Attack | undefined {
  if (enemyTaunts(ctx.view).length === 0) return undefined;
  const options = ctx.legal
    .filter(isAttack)
    .map((attack) => {
      const attacker = unitsOf(ctx.view, "you").find((unit) => unit.instanceId === attack.attackerId);
      const defender = unitsOf(ctx.view, "opponent").find((unit) => unit.instanceId === attack.targetId);
      const dealt = attacker === undefined || defender === undefined ? 0 : blow(attacker.attack, defender);
      return { attack, dealt, survives: outcome(ctx.view, attack)?.survives === true };
    })
    .filter((entry) => entry.survives && entry.dealt > 0);
  options.sort((a, b) => b.dealt - a.dealt);
  return options[0]?.attack;
}

/** What the last step asks for next: play what you can, then attack well, then wear a Taunt down, else end the turn. */
function nextMove(ctx: CoachCtx): ActionBody | undefined {
  return bestPlay(ctx) ?? goodAttack(ctx) ?? chip(ctx) ?? ctx.legal.find((action) => action.type === "endTurn");
}

function sameAction(a: ActionBody, b: ActionBody | undefined): boolean {
  return b !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------------------------
// the script
// ---------------------------------------------------------------------------------------------

export const script: LessonScript = {
  lessonId: "spells",
  steps: [
    info({
      id: "welcome",
      title: "Spells and keywords",
      text: "This time you'll cast spells, and meet keywords: short words on a card, like Taunt or Rush, that change how it fights.",
    }),
    keepHand({
      id: "keep",
      title: "Keep your hand",
      text: "These cards suit this lesson. Press Confirm to keep them all.",
    }),
    onTurn(
      1,
      playCard({
        id: "first-unit",
        defId: VANILLA,
        title: "Play Mr. Vanilla",
        text: "Start like last time: play Mr. Vanilla into one of your lanes.",
      }),
    ),
    onTurn(
      1,
      info({
        id: "read-cards",
        title: "Read any card",
        text: "Point at any card (long-press on a phone) to see it large, with what each of its keywords means. Try Tempo Timmy.",
        anchor: (ctx) => {
          if (inHand(ctx.view, TIMMY) !== undefined) return { kind: "handCard", defId: TIMMY };
          return unitOf(ctx.view, "you", TIMMY) === undefined ? { kind: "hand" } : { kind: "unit", side: "you", defId: TIMMY };
        },
        when: myMain,
      }),
    ),
    onTurn(
      1,
      endTurn({
        id: "end-1",
        title: "End your turn",
        text: (ctx) =>
          inHand(ctx.view, TIMMY) === undefined
            ? "Your mana is spent. Press End turn."
            : "Your mana is spent, and Tempo Timmy is for next turn. Press End turn.",
      }),
    ),

    onTurn(
      2,
      attackWith({
        id: "attack-taunt",
        attacker: VANILLA,
        target: { defId: DEFENDER },
        title: "Attack the Taunt",
        text: "Right-house defender has Taunt: while it stands, your units must attack it first. Attack it with Mr. Vanilla.",
      }),
    ),
    onTurn(
      2,
      playAt({
        id: "first-spell",
        defId: LUNAR,
        aim: damageAim(LUNAR_DAMAGE),
        title: "Cast a spell",
        text: (ctx) =>
          `A spell is a one-shot card. Pick Lunar Eclipse, then pick its target: ${aimName(ctx, damageAim(LUNAR_DAMAGE))}. It takes ${String(LUNAR_DAMAGE)} damage.`,
      }),
    ),
    onTurn(
      2,
      playCard({
        id: "play-rush",
        defId: TIMMY,
        title: "Rush",
        text: "Tempo Timmy has Rush: it may attack a unit on the turn it arrives, though not the hero. Play it.",
      }),
    ),
    onTurn(
      2,
      attackWith({
        id: "rush-attack",
        attacker: TIMMY,
        title: "Attack at once",
        text: "No waiting, thanks to Rush: attack with Tempo Timmy right away.",
        when: (ctx) => arrivedThisTurn(ctx.view, TIMMY),
      }),
    ),

    onTurn(
      3,
      playAt({
        id: "cry",
        defId: SORCERER,
        aim: biggestOpen,
        title: "A Cry",
        text: (ctx) =>
          `Twisted Sorcerer has a Cry: an effect as you play it. Play it into a lane, then aim its ${String(SORCERER_DAMAGE)} damage at ${aimName(ctx, biggestOpen)}.`,
      }),
    ),
    onTurn(
      3,
      playAt({
        id: "second-spell",
        defId: TRUE_STRIKE,
        aim: damageAim(TRUE_STRIKE_DAMAGE, true),
        title: "Ignore Armor",
        text: (ctx) => `True Strike deals ${String(TRUE_STRIKE_DAMAGE)} damage, and Armor can't reduce it. Aim it at ${aimName(ctx, damageAim(TRUE_STRIKE_DAMAGE, true))}.`,
      }),
    ),
    onTurn(
      3,
      attackWith({
        id: "first-strike",
        attacker: TIMMY,
        target: { defId: DEFENDER },
        title: "First Strike",
        text: "Tempo Timmy has First Strike: it hits first, so if that blow kills, it takes no damage back. Attack Right-house defender.",
        // Only when the blow does kill, so the lesson it teaches is the one the board shows.
        when: (ctx) => {
          const attack = ctx.legal
            .filter(isAttack)
            .find(
              (candidate) =>
                candidate.attackerId === unitOf(ctx.view, "you", TIMMY)?.instanceId &&
                candidate.targetId === unitOf(ctx.view, "opponent", DEFENDER)?.instanceId,
            );
          return attack !== undefined && outcome(ctx.view, attack)?.kills === true;
        },
      }),
    ),
    onTurn(
      3,
      attackWith({
        id: "open-hero",
        attacker: VANILLA,
        target: "hero",
        title: "The way is open",
        text: "No Taunt stands in the way now. Attack the enemy hero with Mr. Vanilla.",
      }),
    ),
    onTurn(
      3,
      endTurn({
        id: "end-3",
        title: "End your turn",
        text: endTurnText("That's the turn: Twisted Sorcerer can attack from your next one. Press End turn."),
      }),
    ),

    onTurn(
      4,
      playAt({
        id: "removal",
        defId: HIT_JOB,
        aim: biggestEnemy,
        title: "Destroy a unit",
        text: (ctx) => `Hit Job destroys a unit outright. It's not damage, so no shield or Armor saves it. Aim it at ${aimName(ctx, biggestEnemy)}.`,
      }),
    ),
    onTurn(4, attackWell({ id: "clear-way", title: "Clear the way", text: attackAdvice, clearing: true })),
    onTurn(
      4,
      playCard({
        id: "play-charge",
        defId: DUELIST,
        title: "Charge",
        text: "Deft Duelist has Charge: it may attack anything on the turn it arrives, even the hero. Play it.",
      }),
    ),
    onTurn(
      4,
      attackWith({
        id: "charge-attack",
        attacker: DUELIST,
        target: "hero",
        title: "Straight at the hero",
        text: "Attack the enemy hero with Deft Duelist now.",
        when: (ctx) => arrivedThisTurn(ctx.view, DUELIST),
      }),
    ),
    onTurn(4, attackWell({ id: "attack-4", title: "Attack", text: attackAdvice })),
    onTurn(4, endTurn({ id: "end-4", title: "End your turn", text: endTurnText("Your mana is spent. Press End turn.") })),

    onTurn(
      5,
      playCard({
        id: "play-guard",
        defId: BIG_D,
        title: "A guard",
        text: "Big D-fender has 0 Attack, so it never attacks. Its job is guarding your hero. Play it.",
      }),
    ),
    onTurn(
      5,
      switchPosition({
        id: "defense",
        defId: BIG_D,
        to: "DEF",
        title: "Defense Position",
        text: "Press the switch button on Big D-fender. In Defense it turns sideways and gains Taunt and Armor, so enemies must hit it first.",
      }),
    ),
    {
      id: "win",
      kind: "act",
      title: "Win the game",
      text: "Now finish it: bring the enemy hero to 0. Play your cards, clear any Taunt, and hit the hero with everything else.",
      anchor: { kind: "hero", side: "opponent" },
      when: myMain,
      done: (ctx) => ctx.view.result !== null,
      expect: (action, ctx) => sameAction(action, nextMove(ctx)),
      final: true,
    },
  ],
  tips: [
    tip({
      id: "coin",
      title: "The Coin",
      text: "The AI played The Coin: whoever goes second gets one, for 1 extra mana once.",
      anchor: { kind: "hero", side: "opponent" },
      when: (ctx) => freshOf(ctx, "cardPlayed").some((event) => event.defId === COIN && event.player !== ctx.view.viewer),
      holdAi: true,
    }),
    tip({
      id: "taunt",
      title: "Taunt",
      text: (ctx) => {
        const unit = enemyTaunts(ctx.view)[0];
        return `The AI's ${unit === undefined ? "unit" : (NAMES[unit.defId] ?? "unit")} has Taunt: your units must attack it before anything else.`;
      },
      anchor: (ctx) => {
        const unit = enemyTaunts(ctx.view)[0];
        return unit === undefined ? null : { kind: "unit", side: "opponent", defId: unit.defId };
      },
      when: (ctx) => enemyTaunts(ctx.view).some((unit) => unit.position === "ATK"),
      holdAi: true,
    }),
    tip({
      id: "shield",
      title: "Divine Shield",
      text: "Divine Shield: the shield took that whole hit, then broke. The next hit does damage.",
      when: (ctx) => {
        const theirs = new Set(unitsOf(ctx.view, "opponent").map((unit) => unit.instanceId));
        return freshOf(ctx, "divineShieldLost").some((event) => theirs.has(event.instanceId));
      },
    }),
    tip({
      id: "reborn",
      title: "Reborn",
      text: "Reborn: the first time it dies, it comes back with 1 health, shield and Taunt too. It only does this once.",
      anchor: { kind: "unit", side: "opponent", defId: DEFENDER },
      when: (ctx) => {
        const died = new Set(freshOf(ctx, "destroyed").map((event) => event.instanceId));
        return freshOf(ctx, "summoned").some((event) => event.player !== ctx.view.viewer && died.has(event.instanceId));
      },
    }),
    tip({
      id: "spent",
      title: "Spells are spent",
      text: "Lunar Eclipse went to your graveyard: a spell works once. It also made your next spell this turn cost 1 less.",
      anchor: { kind: "graveyard", side: "you" },
      when: (ctx) => ctx.view.you.graveyard.some((card) => card.defId === LUNAR),
    }),
    tip({
      id: "ai-defense",
      title: "The AI defends",
      text: "The AI turned a unit sideways: Defense Position. It gains Taunt and Armor, but it can't attack.",
      anchor: (ctx) => {
        const unit = unitsOf(ctx.view, "opponent").find((candidate) => candidate.position === "DEF");
        return unit === undefined ? { kind: "units", side: "opponent" } : { kind: "unit", side: "opponent", defId: unit.defId };
      },
      when: (ctx) => unitsOf(ctx.view, "opponent").some((unit) => unit.position === "DEF"),
      holdAi: true,
    }),
    tip({
      id: "defense-back",
      title: "Switching back",
      text: "A unit in Defense can't attack. The same button switches it back, but a switch uses up that unit's action for the turn.",
      anchor: (ctx) => {
        const unit = unitsOf(ctx.view, "you").find((candidate) => candidate.position === "DEF");
        return unit === undefined ? null : { kind: "unit", side: "you", defId: unit.defId };
      },
      when: (ctx) => unitsOf(ctx.view, "you").some((unit) => unit.position === "DEF"),
    }),
    tip({
      id: "ai-spell",
      title: "The AI's spells",
      text: "The AI cast a spell at you. Its spells can hit your units or your hero, just like yours.",
      // Lunar Eclipse is the AI deck's one spell with a target (lessons/spells.ts).
      when: (ctx) => freshOf(ctx, "cardPlayed").some((event) => event.player !== ctx.view.viewer && event.defId === LUNAR),
    }),
    tip({
      id: "lifesteal",
      title: "Lifesteal",
      text: "Jilliax has Lifesteal: the damage it deals heals the AI's hero by as much.",
      anchor: { kind: "hero", side: "opponent" },
      when: (ctx) => {
        // Jilliax on the AI's side, or dying in the very exchange that healed its hero.
        const jilliax = new Set([
          ...unitsOf(ctx.view, "opponent").filter((unit) => unit.defId === JILLIAX).map((unit) => unit.instanceId),
          ...freshOf(ctx, "destroyed").filter((event) => event.defId === JILLIAX && event.owner !== ctx.view.viewer).map((event) => event.instanceId),
        ]);
        const struck = freshOf(ctx, "damage").some((event) => event.sourceId !== null && jilliax.has(event.sourceId) && event.amount > 0);
        return struck && freshOf(ctx, "healed").some((event) => event.targetId === heroTargetId(ctx.view, "opponent"));
      },
    }),
    tip({
      id: "fatigue",
      title: "An empty deck",
      text: "The AI's deck is empty. From now on, each card it should draw hurts its hero instead: 1, then 2, then 3.",
      anchor: { kind: "library", side: "opponent" },
      when: (ctx) => ctx.view.result === null && ctx.view.opponent.libraryCount === 0,
    }),
    tip({
      id: "armor",
      title: "Armor",
      text: "4-mana 7/7 has Armor 7: every hit on it is 7 smaller, so small units can't hurt it at all.",
      anchor: { kind: "unit", side: "you", defId: SEVEN },
      when: (ctx) => unitOf(ctx.view, "you", SEVEN) !== undefined,
    }),
  ],
};
