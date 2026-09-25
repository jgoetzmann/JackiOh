// Lesson "traps"'s coach script (SPEC §9.10): the steps the coach walks the player through, and the
// tips it shows when something new happens. Written against this lesson's fixed seed and decks
// (lessons.ts), so it may name the cards the seed deals.
//
// The coach's line, turn by turn (the player's turns; the AI's in brackets):
//  1. Going Long (Quickdraw) is in the opening hand. Set Bear Honeypot face-down; with no mana left
//     and nothing on the board the turn ends by itself (R82).
//     [The AI plays The Coin, which costs 0: Bear Honeypot springs and makes two Rush Tokens.]
//  2. Play Rush Token Farm, a Field Spell, and attack with the Rush Tokens.
//  3. The farm made a Rush Token at the start of the turn. Play Going Long: Armor 2 for the hero.
//     [The AI's hit on the hero is 2 smaller; the AI sets a face-down card: Sheepish.]
//  4. Test the face-down card with Tempo Timmy, which Sheepish turns into a Sheep.
//  5–7. Win.
//
// Every step reads only the view and the legal actions (CLAUDE.md rule 7). A card step whose card
// the seed deals later waits for the draw rather than going moot, and every step that waits on the
// AI goes moot once its moment has passed, so a player who plays in another order is never stranded.

import { COIN_DEF_ID } from "@jackioh/engine/config";
import type { ActionBody, CardView, PlayerView } from "@jackioh/shared";

import type { CoachCtx, CoachStep, LessonScript } from "../coach.ts";
import { freshOf, heroTargetId, info, inHand, keepHand, legalAttacks, myHand, myMain, playCard, tip, unitOf } from "../steps.ts";

const GOING_LONG = "core-084";
const HONEYPOT = "core-060";
const SHEEPISH = "core-041";
const FARM = "core-058";
const RUSH_TOKEN = "core-t-rush";
const SHEEP = "core-t-sheep";

/** The cheap units of the lesson's deck a player may test a face-down card with, best first. */
const CHEAP_UNITS: Readonly<Record<string, string>> = {
  "core-011": "Tempo Timmy",
  "core-015": "Me and Mr Token",
  "core-003": "Right-house defender",
};

/** The bait step's last chance: the player's own turn after which it goes quietly. */
const BAIT_LAST_TURN = 7;
/** The token-attack step's last chance, while it waits with no token on the board. */
const TOKEN_ATTACK_LAST_TURN = 4;

/** The game turn on which the human's own turn `n` falls (p1 takes the odd ones). */
function gameTurnOf(ctx: CoachCtx, n: number): number {
  return ctx.view.viewer === "p1" ? 2 * n - 1 : 2 * n;
}

function enemyFaceDown(ctx: CoachCtx): boolean {
  return ctx.view.opponent.backrow.some((card) => card !== null && card.faceDown);
}

/** The backrow lane (1-based) holding the human's own card of this definition, if any. */
function myBackrowLane(ctx: CoachCtx, defId: string): number | undefined {
  const index = ctx.view.you.backrow.findIndex((card) => card !== null && !card.faceDown && card.defId === defId);
  return index < 0 ? undefined : index + 1;
}

/** The card has been played already: it is on the field, or has gone to the graveyard or exile. */
function played(ctx: CoachCtx, defId: string): boolean {
  const you = ctx.view.you;
  return (
    myBackrowLane(ctx, defId) !== undefined ||
    unitOf(ctx.view, "you", defId) !== undefined ||
    you.graveyard.some((card) => card.defId === defId) ||
    you.exile.some((card) => card.defId === defId)
  );
}

function trapFiredBy(ctx: CoachCtx, mine: boolean, defId?: string): boolean {
  return freshOf(ctx, "trapFired").some(
    (event) => (event.controller === ctx.view.viewer) === mine && (defId === undefined || event.defId === defId),
  );
}

/**
 * "Play this card", for a card the seed deals a turn or two in: it waits for the draw rather than
 * going moot while the card is still in the library, and goes moot only once it has been played
 * without the coach.
 */
function playWhenDrawn(options: Parameters<typeof playCard>[0]): CoachStep {
  const step = playCard(options);
  return {
    ...step,
    moot: (ctx, since) => since === null && inHand(ctx.view, options.defId) === undefined && played(ctx, options.defId),
  };
}

/** The cheap unit in hand the coach suggests testing a face-down card with, if the engine offers its play. */
function baitIn(ctx: CoachCtx): CardView | undefined {
  const hand = myHand(ctx.view);
  for (const defId of Object.keys(CHEAP_UNITS)) {
    const card = hand.find((candidate) => candidate.defId === defId);
    if (card !== undefined && ctx.legal.some((action) => action.type === "play" && action.instanceId === card.instanceId)) return card;
  }
  return undefined;
}

function baitPlayed(ctx: CoachCtx): boolean {
  return (
    trapFiredBy(ctx, false) ||
    freshOf(ctx, "summoned").some((event) => event.player === ctx.view.viewer && event.row === "units" && CHEAP_UNITS[event.defId] !== undefined)
  );
}

/**
 * "Test the face-down card with a cheap unit." Shows on the player's main phase while the AI has a
 * face-down card and a cheap unit can be played; done once one has been played (or a trap of the
 * AI's has sprung); moot when the turn it showed on ends without one, or when the lesson is far
 * enough along that the moment has passed.
 */
const bait: CoachStep = {
  id: "bait",
  kind: "act",
  title: "Test the trap",
  text: (ctx) => {
    const card = baitIn(ctx);
    const name = card === undefined ? "a cheap unit" : (CHEAP_UNITS[card.defId] ?? "a cheap unit");
    return `That face-down card could be a trap. Test it with a cheap unit before you risk a good one: play ${name}.`;
  },
  anchor: (ctx) => {
    const card = baitIn(ctx);
    return card === undefined ? { kind: "backrow", side: "opponent" } : { kind: "handCard", defId: card.defId };
  },
  when: (ctx) => myMain(ctx) && enemyFaceDown(ctx) && baitIn(ctx) !== undefined,
  done: (ctx) => baitPlayed(ctx),
  moot: (ctx, since) => (since === null ? ctx.view.turn > gameTurnOf(ctx, BAIT_LAST_TURN) : ctx.view.turn !== since.turn && !baitPlayed(ctx)),
  expect: (action: ActionBody, ctx) => {
    const card = baitIn(ctx);
    return card !== undefined && action.type === "play" && action.instanceId === card.instanceId;
  },
};

/** The instance ids of the human's Rush Tokens on this view. */
function myTokenIds(view: PlayerView): Set<string> {
  return new Set(view.you.units.filter((unit) => unit !== null && unit.defId === RUSH_TOKEN).map((unit) => unit?.instanceId ?? ""));
}

function tokenAttacked(ctx: CoachCtx, since: PlayerView): boolean {
  const tokens = myTokenIds(since);
  return freshOf(ctx, "attackDeclared").some((event) => !event.forced && tokens.has(event.attackerId));
}

/**
 * "Attack with a Rush Token." `attackWith` finds its unit by definition, and the trap made two
 * tokens of one definition, so this one remembers the tokens standing when it showed: done once
 * any of them has attacked, even when that attack ended the turn by itself (R82) and so arrived
 * on the next turn's view; moot when the turn ends without one.
 */
const tokenAttack: CoachStep = {
  id: "token-attack",
  kind: "act",
  title: "Tokens fight too",
  text: "A token fights like any other unit. Attack with a Rush Token.",
  anchor: { kind: "unit", side: "you", defId: RUSH_TOKEN },
  when: (ctx) => myMain(ctx) && legalAttacks(ctx, RUSH_TOKEN).length > 0,
  done: (ctx, since) => tokenAttacked(ctx, since),
  moot: (ctx, since) => {
    if (since === null) return unitOf(ctx.view, "you", RUSH_TOKEN) === undefined && ctx.view.turn > gameTurnOf(ctx, TOKEN_ATTACK_LAST_TURN);
    return ctx.view.turn !== since.turn && !tokenAttacked(ctx, since);
  },
  expect: (action: ActionBody, ctx) => {
    const tokens = myTokenIds(ctx.view);
    return action.type === "attack" && tokens.has(action.attackerId);
  },
};

// A tip's text is read again on every view while it shows, so these read what stays on the board
// (the graveyards, the units, the view's recent events) rather than only the events that set the
// tip off, which the next view no longer carries.

/** "Your trap sprang": names The Coin when that is what the AI played into it (§7: it costs 0). */
function honeypotText(ctx: CoachCtx): string {
  const coin = ctx.view.opponent.graveyard.some((card) => card.defId === COIN_DEF_ID);
  const what = coin ? "The AI played The Coin, which costs 0" : "The AI played a card costing 1 or less";
  return `${what}, so your Bear Honeypot sprang on its turn and made two Rush Tokens. A trap that has fired goes to the graveyard.`;
}

/** "The AI's trap": names Sheepish, and the unit it turned into a Sheep, when that is what happened. */
function enemyTrapText(ctx: CoachCtx): string {
  const sheepish = ctx.view.opponent.graveyard.some((card) => card.defId === SHEEPISH) || unitOf(ctx.view, "you", SHEEP) !== undefined;
  if (!sheepish) return "The AI's face-down card was a trap, and your play set it off. Its zone is empty again.";
  const sheeped = [...ctx.view.events].reverse().find((event) => event.type === "transformed" && event.toDefId === SHEEP);
  const name = sheeped?.type === "transformed" ? CHEAP_UNITS[sheeped.fromDefId] : undefined;
  return `It was Sheepish, a trap: it turned ${name ?? "your unit"} into a 1/1 Sheep. Better to lose your cheapest unit than your best one.`;
}

export const script: LessonScript = {
  lessonId: "traps",
  steps: [
    keepHand({ id: "keep", title: "Keep your hand", text: "Press Ready to keep all of these cards." }),
    info({
      id: "welcome",
      title: "The backrow",
      text: "Behind your units is a second row of five zones: the backrow. Traps and Field Spells go there, never units.",
      anchor: { kind: "backrow", side: "you" },
      when: (ctx) => myMain(ctx),
    }),
    info({
      id: "quickdraw",
      title: "Quickdraw",
      text: "Going Long has Quickdraw: a Quickdraw card always starts in your opening hand, so you can plan on it.",
      anchor: { kind: "handCard", defId: GOING_LONG },
      when: (ctx) => myMain(ctx),
      moot: (ctx, since) => since === null && inHand(ctx.view, GOING_LONG) === undefined,
    }),
    playCard({
      id: "set-trap",
      title: "Set a trap",
      text: "Bear Honeypot is a Trap. Pay 1 mana and drag it into your backrow. It goes in face-down, so the AI can't see what it is.",
      defId: HONEYPOT,
    }),
    info({
      id: "trap-waits",
      title: "A hidden trap",
      text: "The AI sees only the back of your card. Bear Honeypot springs by itself when the AI plays a card costing 1 or less, even on its turn.",
      anchor: (ctx) => {
        const lane = myBackrowLane(ctx, HONEYPOT);
        return lane === undefined ? { kind: "backrow", side: "you" } : { kind: "backrow", side: "you", lane };
      },
      when: (ctx) => myBackrowLane(ctx, HONEYPOT) !== undefined,
      // Set, it shows at once (the turn usually ends by itself, R82, so on the AI's turn); not set
      // by the player's next main phase, or already sprung, its moment has passed.
      moot: (ctx, since) =>
        since === null && myBackrowLane(ctx, HONEYPOT) === undefined && (myMain(ctx) || played(ctx, HONEYPOT)),
      holdAi: true,
    }),
    playWhenDrawn({
      id: "field-spell",
      title: "A Field Spell",
      text: "Rush Token Farm is a Field Spell. It stays face-up in your backrow and makes a Rush Token at the start of each of your turns.",
      defId: FARM,
    }),
    tokenAttack,
    info({
      id: "farm-works",
      title: "The farm at work",
      text: "At the start of your turn, Rush Token Farm made a new Rush Token. A Field Spell keeps working, turn after turn.",
      anchor: (ctx) =>
        unitOf(ctx.view, "you", RUSH_TOKEN) === undefined ? { kind: "backrow", side: "you" } : { kind: "unit", side: "you", defId: RUSH_TOKEN },
      when: (ctx) =>
        myMain(ctx) &&
        myBackrowLane(ctx, FARM) !== undefined &&
        freshOf(ctx, "summoned").some((event) => event.player === ctx.view.viewer && event.defId === RUSH_TOKEN),
      // The farm is not in the backrow on the player's main phase: never played, or gone.
      moot: (ctx, since) => since === null && myBackrowLane(ctx, FARM) === undefined && (myMain(ctx) || played(ctx, FARM)),
    }),
    playCard({
      id: "going-long",
      title: "Armor for your hero",
      text: "Going Long is a Field Spell too. While it stays in your backrow, your hero has Armor 2: every hit on it is 2 smaller.",
      defId: GOING_LONG,
    }),
    bait,
    info({
      id: "win",
      title: "Win the game",
      text: "You know the backrow now. Bring the enemy hero to 0 health, and mind any new face-down card.",
      final: true,
    }),
  ],
  tips: [
    tip({
      id: "honeypot-fired",
      title: "Your trap sprang",
      text: honeypotText,
      anchor: { kind: "units", side: "you" },
      when: (ctx) => trapFiredBy(ctx, true, HONEYPOT),
      holdAi: true,
    }),
    tip({
      id: "tokens",
      title: "Tokens",
      text: "A Rush Token is a token: a unit another card makes. It is 3/3 with Rush. A token vanishes for good when it leaves the field.",
      anchor: { kind: "unit", side: "you", defId: RUSH_TOKEN },
      when: (ctx) => unitOf(ctx.view, "you", RUSH_TOKEN) !== undefined,
      holdAi: true,
    }),
    tip({
      id: "enemy-facedown",
      title: "A face-down card",
      text: "The AI set a face-down card in its backrow. It could be a trap, and only the AI knows what it is.",
      anchor: { kind: "backrow", side: "opponent" },
      when: (ctx) => enemyFaceDown(ctx),
      holdAi: true,
    }),
    tip({
      id: "armor",
      title: "Armor at work",
      text: "Going Long's Armor 2 made that hit on your hero 2 smaller. It works on every hit, for as long as Going Long stays.",
      anchor: { kind: "hero", side: "you" },
      when: (ctx) =>
        myBackrowLane(ctx, GOING_LONG) !== undefined &&
        freshOf(ctx, "damage").some((event) => event.targetId === heroTargetId(ctx.view, "you")),
    }),
    tip({
      id: "enemy-trap",
      title: "The AI's trap",
      text: enemyTrapText,
      anchor: { kind: "units", side: "you" },
      when: (ctx) => trapFiredBy(ctx, false),
    }),
  ],
};
