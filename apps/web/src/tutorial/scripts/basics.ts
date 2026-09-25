// Lesson "basics"'s coach script (SPEC §9.10): the steps the coach walks the player through, and the
// tips it shows when something new happens. Written against this lesson's fixed seed and decks
// (lessons.ts), so it may name the cards the seed deals.
//
// The line it is written for (lessons/basics.ts has the deal): turn 1 Mr. Vanilla; turn 2 Mr.
// Vanilla hits the enemy hero and Duplicating Felinors arrives; turn 3 Jlockeed Shredder-10; turn 4
// a trade, then the rule of thumb, and the last step until the enemy hero falls. Every step reads
// only the view and the legal actions (CLAUDE.md rule 7), so a player who strays from the line —
// plays another card, attacks elsewhere, ends the turn early — is met where they are: a step whose
// moment has passed retires, and the attack steps pick attacker and target from the board as it is.

import type { ActionBody, UnitView } from "@jackioh/shared";

import type { CoachAnchor, CoachCtx, CoachStep, LessonScript } from "../coach.ts";
import {
  freshOf,
  heroTargetId,
  info,
  inHand,
  isMyTurn,
  keepHand,
  mulliganOpen,
  myMain,
  myTurnNumber,
  playCard,
  tip,
  unitOf,
  unitsOf,
} from "../steps.ts";

const VANILLA = "core-008";
const FELINORS = "core-012";
const SHREDDER = "core-013";
const POSTDOC = "core-061";
const GARY = "core-004";
const MENACE = "core-019";
const SEVEN = "core-025";
const MOTHS = "core-009";
const COIN = "core-t-coin";

/** The names of the cards the coach may name: both decks of the lesson. */
const NAMES: Readonly<Record<string, string>> = {
  "core-001": "Big D-fender",
  "core-003": "Right-house defender",
  "core-004": "Gary the Gambler",
  "core-008": "Mr. Vanilla",
  "core-009": "Moths to the Flame",
  "core-011": "Tempo Timmy",
  "core-012": "Duplicating Felinors",
  "core-013": "Jlockeed Shredder-10",
  "core-015": "Me and Mr Token",
  "core-019": "Midrange Menace",
  "core-020": "Pointmaster",
  "core-022": "Carnivorous Cube",
  "core-025": "4-mana 7/7",
  "core-030": "Archivist",
  "core-032": "Prem Panther",
  "core-037": "Gravedigger",
  "core-045": "Deft Duelist",
  "core-053": "Reno",
  "core-054": "Straaza",
  "core-056": "Jilliax",
  "core-061": "Prejudiced Postdoc",
  "core-066": "The Rock",
  "core-068": "Twisted Sorcerer",
  "core-077": "Professor Curvature",
};

function nameOf(defId: string, fallback: string): string {
  return NAMES[defId] ?? fallback;
}

type Attack = Extract<ActionBody, { type: "attack" }>;
type Play = Extract<ActionBody, { type: "play" }>;

function attacks(ctx: CoachCtx): Attack[] {
  return ctx.legal.filter((action): action is Attack => action.type === "attack");
}

function mine(ctx: CoachCtx, instanceId: string): UnitView | undefined {
  return unitsOf(ctx.view, "you").find((unit) => unit.instanceId === instanceId);
}

function theirs(ctx: CoachCtx, instanceId: string): UnitView | undefined {
  return unitsOf(ctx.view, "opponent").find((unit) => unit.instanceId === instanceId);
}

function has(unit: UnitView, keyword: string): boolean {
  return unit.keywords.some((entry) => entry.kind === keyword);
}

/** One unit's blow on another, as the view shows them: its attack less the target's Armor. */
function blow(from: UnitView, to: UnitView): number {
  if (has(to, "Divine Shield")) return 0;
  return Math.max(0, from.attack - to.armor);
}

type Trade = { action: Attack; attacker: UnitView; target: UnitView; dealt: number; taken: number; kills: boolean; survives: boolean };

/** Every legal attack on an enemy unit, with what the view says it would do. */
function trades(ctx: CoachCtx): Trade[] {
  const out: Trade[] = [];
  for (const action of attacks(ctx)) {
    const attacker = mine(ctx, action.attackerId);
    const target = theirs(ctx, action.targetId);
    if (attacker === undefined || target === undefined) continue;
    const dealt = blow(attacker, target);
    const kills = dealt >= target.health;
    const strikesFirst = has(attacker, "First Strike") && !has(target, "First Strike");
    const taken = kills && strikesFirst ? 0 : blow(target, attacker);
    out.push({ action, attacker, target, dealt, taken, kills, survives: taken < attacker.health });
  }
  return out;
}

const size = (unit: UnitView): number => unit.attack + unit.health;

/**
 * The trade the coach suggests: one that destroys the enemy unit and leaves the attacker standing,
 * the biggest such target first, and for it the smallest attacker that does it.
 */
function goodTrade(ctx: CoachCtx): Trade | undefined {
  const good = trades(ctx).filter((trade) => trade.kills && trade.survives);
  good.sort((a, b) => size(b.target) - size(a.target) || size(a.attacker) - size(b.attacker));
  return good[0];
}

/**
 * The zone a unit stands in, as an anchor. A `unit` anchor finds the first unit of its card, and the
 * enemy may hold two of a name (Prejudiced Postdoc's copy of a Mr. Vanilla beside its own), so the
 * coach marks the one it means by its zone.
 */
function zoneAnchor(ctx: CoachCtx, side: "you" | "opponent", instanceId: string): CoachAnchor | null {
  const units = side === "you" ? ctx.view.you.units : ctx.view.opponent.units;
  const index = units.findIndex((unit) => unit?.instanceId === instanceId);
  return index < 0 ? null : { kind: "zone", side, row: "units", lane: index + 1 };
}

/** The attack on the enemy hero the coach suggests: Mr. Vanilla's when it may, else the strongest. */
function heroAttack(ctx: CoachCtx): { action: Attack; attacker: UnitView } | undefined {
  const hero = heroTargetId(ctx.view, "opponent");
  const options = attacks(ctx)
    .filter((action) => action.targetId === hero)
    .map((action) => ({ action, attacker: mine(ctx, action.attackerId) }))
    .filter((entry): entry is { action: Attack; attacker: UnitView } => entry.attacker !== undefined);
  options.sort((a, b) => Number(b.attacker.defId === VANILLA) - Number(a.attacker.defId === VANILLA) || b.attacker.attack - a.attacker.attack);
  return options[0];
}

/**
 * When a Taunt unit keeps the hero out of reach and no attack on it destroys it, the hit that wears
 * it down most while the attacker survives: damage stays, so the next hit finishes it.
 */
function chip(ctx: CoachCtx): Trade | undefined {
  if (heroAttack(ctx) !== undefined) return undefined;
  const options = trades(ctx).filter((trade) => trade.survives && trade.dealt > 0);
  options.sort((a, b) => b.dealt - a.dealt || a.taken - b.taken);
  return options[0];
}

/** A play aimed at none of the human's own cards (the harness's autopilot reads plays the same way). */
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

/** What the last step asks for next: play what you can, trade when it pays, else the hero, else end the turn. */
function nextMove(ctx: CoachCtx): ActionBody | undefined {
  return (
    bestPlay(ctx) ??
    goodTrade(ctx)?.action ??
    heroAttack(ctx)?.action ??
    chip(ctx)?.action ??
    ctx.legal.find((action) => action.type === "endTurn")
  );
}

function same(a: ActionBody, b: ActionBody | undefined): boolean {
  return b !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

/** The human declared an attack of their own on this view, at the hero or at a unit. */
function attacked(ctx: CoachCtx, at: "hero" | "unit"): boolean {
  const hero = heroTargetId(ctx.view, "opponent");
  const own = (instanceId: string): boolean =>
    mine(ctx, instanceId) !== undefined || ctx.view.you.graveyard.some((card) => card.instanceId === instanceId);
  return freshOf(ctx, "attackDeclared").some(
    (event) => !event.forced && own(event.attackerId) && (at === "hero" ? event.targetId === hero : event.targetId !== hero),
  );
}

/** "End your turn" on the human's own turn `n`: retired unasked once that turn is behind them. */
function endTurnOn(n: number, options: { id: string; title: string; text: string; when?: (ctx: CoachCtx) => boolean }): CoachStep {
  const { when, ...rest } = options;
  return {
    kind: "act",
    anchor: { kind: "endTurn" },
    ...rest,
    when: (ctx) => myMain(ctx) && myTurnNumber(ctx.view) === n && (when === undefined || when(ctx)),
    done: (ctx, since) => ctx.view.turn !== since.turn,
    moot: (ctx, since) => since === null && myTurnNumber(ctx.view) > n,
    expect: (action) => action.type === "endTurn",
  };
}

/** An info step for the human's own turn `n`, retired unshown once that turn is behind them. */
function infoOn(n: number, options: Parameters<typeof info>[0]): CoachStep {
  const { when, ...rest } = options;
  return info({
    ...rest,
    when: (ctx) => myMain(ctx) && myTurnNumber(ctx.view) === n && (when === undefined || when(ctx)),
    moot: (ctx, since) => since === null && myTurnNumber(ctx.view) > n,
  });
}

/** "Play this card", retired unasked once the card is on the field some other way or turn `byTurn` is past. */
function playBy(byTurn: number, options: Parameters<typeof playCard>[0]): CoachStep {
  const step = playCard(options);
  return {
    ...step,
    moot: (ctx, since) =>
      since === null &&
      (myTurnNumber(ctx.view) > byTurn || (inHand(ctx.view, options.defId) === undefined && unitOf(ctx.view, "you", options.defId) !== undefined)),
  };
}

const attackHero: CoachStep = {
  id: "attack-hero",
  kind: "act",
  title: "Attack the hero",
  text: (ctx) => {
    const choice = heroAttack(ctx);
    const name = choice === undefined ? "Your unit" : nameOf(choice.attacker.defId, "Your unit");
    const damage = choice === undefined ? "its attack" : String(choice.attacker.attack);
    return `${name} is ready: it glows green. Drag it onto the enemy hero to deal ${damage} damage. Any unit can attack any target, whatever its lane.`;
  },
  anchor: { kind: "hero", side: "opponent" },
  when: (ctx) => myMain(ctx) && myTurnNumber(ctx.view) >= 2 && heroAttack(ctx) !== undefined,
  done: (ctx, since) => since !== ctx.view && attacked(ctx, "hero"),
  // Gone unasked once its turn has passed, or while a Taunt unit keeps every ready unit off the hero
  // (the "defense" tip says why; the last step asks for the hero again once the way is clear).
  moot: (ctx, since) => {
    if (since !== null) return ctx.view.turn !== since.turn;
    const blocked = myMain(ctx) && heroAttack(ctx) === undefined && attacks(ctx).length > 0;
    return myTurnNumber(ctx.view) > 4 || (myTurnNumber(ctx.view) >= 2 && blocked);
  },
  expect: (action, ctx) => same(action, heroAttack(ctx)?.action),
};

const trade: CoachStep = {
  id: "trade",
  kind: "act",
  title: "Trade units",
  text: (ctx) => {
    const choice = goodTrade(ctx);
    if (choice === undefined) return "Attack an enemy unit: both units hit each other at the same time.";
    const a = nameOf(choice.attacker.defId, "your unit");
    const b = nameOf(choice.target.defId, "the enemy unit");
    return `Attack a unit this time: drag ${a} onto ${b}. Both hit each other at once, ${String(choice.dealt)} damage one way and ${String(choice.taken)} back.`;
  },
  anchor: (ctx): CoachAnchor | null => {
    const choice = goodTrade(ctx);
    return (choice === undefined ? null : zoneAnchor(ctx, "opponent", choice.target.instanceId)) ?? { kind: "units", side: "opponent" };
  },
  when: (ctx) => myMain(ctx) && myTurnNumber(ctx.view) >= 3 && goodTrade(ctx) !== undefined,
  done: (ctx, since) => since !== ctx.view && attacked(ctx, "unit"),
  moot: (ctx, since) => (since === null ? myTurnNumber(ctx.view) > 6 : ctx.view.turn !== since.turn),
  expect: (action, ctx) => same(action, goodTrade(ctx)?.action),
};

/** The last step: until the enemy hero falls, play what you can, trade when it pays, else hit the hero. */
const win: CoachStep = {
  id: "win",
  kind: "act",
  title: "Win the game",
  text: "Finish the job: bring the enemy hero to 0. Trade when your unit survives, hit the hero with the rest, and gang up on a big defender.",
  anchor: { kind: "hero", side: "opponent" },
  when: (ctx) => myMain(ctx),
  done: (ctx) => ctx.view.result !== null,
  expect: (action, ctx) => same(action, nextMove(ctx)),
  final: true,
};

export const script: LessonScript = {
  lessonId: "basics",
  steps: [
    info({
      id: "welcome",
      title: "Welcome to JackiOh",
      text: "You'll learn by playing a real game against a gentle opponent. These three cards are your opening hand.",
      anchor: { kind: "prompt" },
      when: (ctx) => mulliganOpen(ctx.view),
      moot: (ctx, since) => since === null && ctx.view.phase !== "mulligan" && ctx.view.phase !== "setup",
    }),
    keepHand({
      id: "keep",
      title: "Keep your hand",
      text: "You could swap cards here (lesson 4 shows how), but these are good ones. Press Confirm to keep all three.",
    }),
    info({
      id: "your-hero",
      title: "Your hero",
      text: "This is you: your hero, with 30 health. If it ever drops to 0, you lose.",
      anchor: { kind: "hero", side: "you" },
      // The first turn the player can act on: turn 1, unless a hand with nothing to play ended it (R82).
      when: (ctx) => myMain(ctx),
    }),
    info({
      id: "enemy-hero",
      title: "The enemy hero",
      text: "Across the board is the enemy hero. In this lesson it starts with 20 health. Bring it down to 0 and you win.",
      anchor: { kind: "hero", side: "opponent" },
      when: (ctx) => myMain(ctx),
    }),
    info({
      id: "mana",
      title: "Mana",
      text: "This is your mana: 1 crystal on your first turn, one more each turn up to 4. Cards cost mana, and it refills every turn.",
      anchor: { kind: "mana" },
      when: (ctx) => myMain(ctx),
    }),
    playBy(2, {
      id: "play-vanilla",
      title: "Play a unit",
      text: "Mr. Vanilla costs 1 mana: the number at its top left. Drag it into any of your five unit zones (or click it, then a zone). Any lane will do.",
      defId: VANILLA,
    }),
    info({
      id: "sick",
      title: "Not ready yet",
      text: (ctx) => {
        const name = unitOf(ctx.view, "you", VANILLA) === undefined ? "Your unit" : "Mr. Vanilla";
        return `Units can't attack on the turn they arrive. ${name} will be ready on your next turn.`;
      },
      anchor: (ctx) => (unitOf(ctx.view, "you", VANILLA) === undefined ? { kind: "units", side: "you" } : { kind: "unit", side: "you", defId: VANILLA }),
      when: (ctx) => myMain(ctx) && unitsOf(ctx.view, "you").length > 0 && attacks(ctx).length === 0,
      moot: (ctx, since) => since === null && (attacks(ctx).length > 0 || myTurnNumber(ctx.view) > 2),
    }),
    endTurnOn(1, {
      id: "end-1",
      title: "End your turn",
      text: "Your mana is spent. Press End turn: the enemy plays next, then you draw a card and your mana refills.",
    }),
    infoOn(2, {
      id: "new-turn",
      title: "A new turn",
      text: "At the start of your turn you drew a card, and your mana refilled with one more crystal: 2 now.",
      anchor: { kind: "mana" },
    }),
    attackHero,
    playBy(3, {
      id: "play-felinors",
      title: "Two for one",
      text: "Duplicating Felinors costs 2. When you play it, it brings a copy of itself: two units from one card.",
      defId: FELINORS,
    }),
    endTurnOn(2, {
      id: "end-2",
      title: "End your turn",
      text: "Your mana is spent, and the Felinors need a turn before they can attack. Press End turn.",
      when: (ctx) => !ctx.legal.some((action) => action.type === "play" || action.type === "attack"),
    }),
    playBy(4, {
      id: "play-shredder",
      title: "A big unit",
      text: "Jlockeed Shredder-10 costs 3. Play it: it's the biggest unit on the board, and it has a trick you'll see at the end of your turn.",
      defId: SHREDDER,
    }),
    endTurnOn(3, {
      id: "end-3",
      title: "Watch the Shredder",
      text: "Shredder can't attack yet, but press End turn and watch: at the end of each of your turns it hits every enemy for 2.",
    }),
    trade,
    info({
      id: "trade-result",
      title: "How trades work",
      text: "Both units took their damage at once. A unit at 0 health is destroyed and goes to the graveyard; one that lives keeps its damage.",
      anchor: { kind: "graveyard", side: "opponent" },
      // Right after the trade, on the view that shows it: gone unshown if the trade never came.
      when: (ctx) => myMain(ctx),
      moot: (ctx, since) => since === null && !attacked(ctx, "unit"),
    }),
    info({
      id: "rule-of-thumb",
      title: "Unit or hero?",
      text: "A good rule: if your unit can destroy an enemy unit and survive, trade. Otherwise attack the enemy hero: every point counts.",
      anchor: { kind: "units", side: "opponent" },
      when: (ctx) => myMain(ctx) && myTurnNumber(ctx.view) >= 4,
    }),
    win,
  ],
  tips: [
    tip({
      id: "coin",
      title: "The Coin",
      text: "The enemy played The Coin: a bonus card for the player who goes second. It gives 1 extra mana, once.",
      anchor: { kind: "hero", side: "opponent" },
      when: (ctx) => freshOf(ctx, "cardPlayed").some((event) => event.player !== ctx.view.viewer && event.defId === COIN),
      holdAi: true,
    }),
    tip({
      id: "enemy-unit",
      title: "Attack and health",
      text: "The enemy played a unit. Every unit shows its attack in the yellow gem and its health in the red one. Hover a card to read it (press and hold on a phone).",
      anchor: { kind: "units", side: "opponent" },
      when: (ctx) => freshOf(ctx, "summoned").some((event) => event.player !== ctx.view.viewer && event.row === "units"),
      holdAi: true,
    }),
    tip({
      id: "postdoc",
      title: "A plain copy",
      text: "Prejudiced Postdoc brought a plain copy of a Human unit onto the enemy's side: one more body for you to deal with.",
      anchor: { kind: "units", side: "opponent" },
      when: (ctx) =>
        freshOf(ctx, "cardPlayed").some((event) => event.player !== ctx.view.viewer && event.defId === POSTDOC) &&
        freshOf(ctx, "summoned").some((event) => event.player !== ctx.view.viewer && event.defId !== POSTDOC),
    }),
    tip({
      id: "defense",
      title: "Defense Position",
      text: "The enemy turned a unit sideways: Defense Position. It now has Taunt, so your attacks must hit it first, and it takes 1 less damage. More in lesson 2.",
      anchor: (ctx) => {
        const unit = unitsOf(ctx.view, "opponent").find((candidate) => candidate.position === "DEF");
        return (unit === undefined ? null : zoneAnchor(ctx, "opponent", unit.instanceId)) ?? { kind: "units", side: "opponent" };
      },
      when: (ctx) => freshOf(ctx, "positionSwitched").some((event) => event.position === "DEF" && theirs(ctx, event.instanceId) !== undefined),
      holdAi: true,
    }),
    tip({
      id: "enemy-attacks",
      title: "The enemy attacks",
      text: "The enemy attacked too. Its units follow the same rules as yours: one attack each per turn, never on the turn they arrive.",
      anchor: { kind: "hero", side: "you" },
      when: (ctx) =>
        !isMyTurn(ctx.view) && freshOf(ctx, "attackDeclared").some((event) => !event.forced && theirs(ctx, event.attackerId) !== undefined),
    }),
    tip({
      id: "unit-lost",
      title: "A unit lost",
      text: "One of your units was destroyed and went to your graveyard. That's part of the game: trade well and you'll have more left than the enemy.",
      anchor: { kind: "graveyard", side: "you" },
      when: (ctx) => freshOf(ctx, "destroyed").some((event) => event.owner === ctx.view.viewer),
    }),
    tip({
      id: "shredder-fired",
      title: "Shredder at work",
      text: "At the end of your turn Jlockeed Shredder-10 hit every enemy unit and the enemy hero for 2. It does that every turn it stays.",
      anchor: { kind: "unit", side: "you", defId: SHREDDER },
      when: (ctx) => {
        const shredder = unitOf(ctx.view, "you", SHREDDER);
        return shredder !== undefined && freshOf(ctx, "damage").some((event) => event.sourceId === shredder.instanceId && !event.combat);
      },
    }),
    tip({
      id: "gary",
      title: "Heads or tails",
      text: (ctx) => {
        const buff = freshOf(ctx, "buffed").find((event) => [...unitsOf(ctx.view, "you"), ...unitsOf(ctx.view, "opponent")].some((unit) => unit.instanceId === event.instanceId && unit.defId === GARY));
        const got = buff === undefined ? "" : ` This one got +${String(buff.attack)} attack and +${String(buff.health)} health.`;
        return `Gary the Gambler flipped five coins as it arrived: +1 attack for each heads, +1 health for each tails.${got}`;
      },
      anchor: (ctx) => (unitOf(ctx.view, "you", GARY) === undefined ? { kind: "unit", side: "opponent", defId: GARY } : { kind: "unit", side: "you", defId: GARY }),
      when: (ctx) => freshOf(ctx, "summoned").some((event) => event.defId === GARY && event.row === "units"),
    }),
    tip({
      id: "menace",
      title: "A bodyguard",
      text: "Midrange Menace has Taunt, like a unit in Defense Position: enemy attacks must go at it first, so it guards your hero. It heals to full at the end of your turn.",
      anchor: { kind: "unit", side: "you", defId: MENACE },
      when: (ctx) => freshOf(ctx, "summoned").some((event) => event.player === ctx.view.viewer && event.defId === MENACE),
    }),
    tip({
      id: "armor",
      title: "Armor",
      text: "4-mana 7/7 has Armor 7: every hit on it is 7 smaller, so small units barely scratch it.",
      anchor: { kind: "unit", side: "you", defId: SEVEN },
      when: (ctx) => freshOf(ctx, "summoned").some((event) => event.player === ctx.view.viewer && event.defId === SEVEN),
    }),
    tip({
      id: "moths",
      title: "Moths to the Flame",
      text: "Moths to the Flame makes every one of your units attack it at the start of the enemy's turn. They still attack as usual on yours.",
      anchor: { kind: "unit", side: "opponent", defId: MOTHS },
      when: (ctx) => freshOf(ctx, "attackDeclared").some((event) => event.forced),
    }),
    tip({
      id: "enemy-low",
      title: "Almost there",
      text: "The enemy hero is low on health. Look for units that can reach it this turn.",
      anchor: { kind: "hero", side: "opponent" },
      when: (ctx) => myMain(ctx) && ctx.view.opponent.hero.health <= 8,
    }),
    tip({
      id: "enemy-fatigue",
      title: "Out of cards",
      text: "The enemy's deck is empty. Every draw from an empty deck hurts its hero, a little more each time.",
      anchor: { kind: "library", side: "opponent" },
      when: (ctx) => ctx.view.opponent.fatigueCount > 0,
    }),
  ],
};
