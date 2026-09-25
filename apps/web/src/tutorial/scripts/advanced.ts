// Lesson "advanced"'s coach script (SPEC §9.10): the steps the coach walks the player through, and the
// tips it shows when something new happens. Written against this lesson's fixed seed and decks
// (lessons.ts), so it may name the cards the seed deals.
//
// The line it walks, on the lesson's seed: send the 4-mana 7/7 back in the mulligan (§2.1 step 3);
// play The Coin (R244, R245) and Felinor Fiender with it on the first turn; fill the board with
// Felinor Tokens on the second, which Fiender counts (§7, #62, #92); make The Rock Radiant with Glowy
// Jelly Bean on the third (§5.2, #26); play The Rock on the fourth with a Felinor Token as its
// Tribute (§6.3, #66); and on the fifth play Reno, which glows yellow because the hero is hurt
// (R195). Radiant numbers are never stated: the coach says "stronger" and points at the card, so the
// text holds whatever the Radiant faces become.
//
// Every turn of the player's ends in `yourMove` (advice.ts), which names the next sensible move
// once the turn's lesson is through, so the coach is never silent on the player's own turn; the last
// one lasts until the game is won. A turn's lesson that cannot happen when the player's turn comes
// (a card it needs is missing, or the mana, or a free zone), or no longer can because the player
// spent the mana on something else, is dropped rather than waited for (`outOfReach`): the coach goes
// straight on to the turn's `yourMove` instead of pointing at a play the engine will not take.
//
// Every read is of the view or of `legalActions` (CLAUDE.md rule 7): "can The Rock be played with a
// token as its Tribute?" is answered by finding that play among the legal ones, never by counting
// zones here.

import type { ActionBody, PlayerView } from "@jackioh/shared";

import { moveText, nextMove, yourMove } from "../advice.ts";
import type { CoachCtx, CoachStep, LessonScript } from "../coach.ts";
import {
  freshOf,
  info,
  inHand,
  legalPlays,
  mulliganAway,
  mulliganOpen,
  myHand,
  myMain,
  myTurnNumber,
  playCard,
  tip,
  unitOf,
  unitsOf,
} from "../steps.ts";

const COIN = "core-t-coin";
const FELINOR_TOKEN = "core-t-felinor";
const FRIEND_OF_FELINORS = "core-062";
const FELINOR_FIENDER = "core-092";
const GLOWY_JELLY_BEAN = "core-026";
const THE_ROCK = "core-066";
const SEVEN_SEVEN = "core-025";
const RADIANT_SAINTESS = "core-081";
const RENO = "core-053";

type Play = Extract<ActionBody, { type: "play" }>;

/** The mulligan is behind us: both players have answered it (§2.1 step 3). */
function pastMulligan(view: PlayerView): boolean {
  return view.phase !== "mulligan" && view.phase !== "setup";
}

/** The human's Felinor Tokens on the field. */
function myTokens(view: PlayerView): string[] {
  return unitsOf(view, "you")
    .filter((unit) => unit.defId === FELINOR_TOKEN)
    .map((unit) => unit.instanceId);
}

function fienderOnField(ctx: CoachCtx): boolean {
  return unitOf(ctx.view, "you", FELINOR_FIENDER) !== undefined;
}

/** The Rock is Radiant, in hand or on the field. */
function rockRadiant(view: PlayerView): boolean {
  return inHand(view, THE_ROCK)?.radiant === true || unitOf(view, "you", THE_ROCK)?.radiant === true;
}

function sameAction(a: ActionBody, b: ActionBody): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The plays of Glowy Jelly Bean that pick The Rock. */
function beanOnRock(ctx: CoachCtx): Play[] {
  const rock = inHand(ctx.view, THE_ROCK);
  if (rock === undefined) return [];
  return legalPlays(ctx, GLOWY_JELLY_BEAN).filter((play) =>
    (play.targets ?? []).some((target) => target.pick === "instance" && target.instanceId === rock.instanceId),
  );
}

/**
 * The plays of The Rock the coach asks for: a Felinor Token as the Tribute when there is one, or
 * else the unit worth least (its attack plus health), so the text's advice is what the play does.
 */
function rockPlays(ctx: CoachCtx): Play[] {
  const plays = legalPlays(ctx, THE_ROCK);
  const tokens = new Set(myTokens(ctx.view));
  const onTokens = plays.filter((play) => (play.tributes ?? []).length > 0 && (play.tributes ?? []).every((id) => tokens.has(id)));
  if (onTokens.length > 0) return onTokens;
  const worth = (id: string): number => {
    const unit = unitsOf(ctx.view, "you").find((candidate) => candidate.instanceId === id);
    return unit === undefined ? Number.MAX_SAFE_INTEGER : unit.attack + unit.health;
  };
  const cost = (play: Play): number => (play.tributes ?? []).reduce((sum, id) => sum + worth(id), 0);
  const cheapest = Math.min(...plays.map(cost));
  return plays.filter((play) => cost(play) === cheapest);
}

/** Reno glows yellow in hand (its condition is met, R195) and the engine offers a play of it. */
function renoReady(ctx: CoachCtx): boolean {
  return inHand(ctx.view, RENO)?.conditionActive === true && legalPlays(ctx, RENO).length > 0;
}

/**
 * It is the player's main phase and what a step is about cannot happen: the step is dropped, shown
 * or not, so the coach moves on to the turn's `yourMove` rather than wait for it or point at a play
 * the engine does not offer.
 */
function outOfReach(ctx: CoachCtx, possible: (ctx: CoachCtx) => boolean): boolean {
  return myMain(ctx) && !possible(ctx);
}

/** The rest of the player's turn: `yourMove` names each next move and is done once the turn has passed. */
function restOfTurn(id: string): CoachStep {
  return yourMove({ id, title: "Your move" });
}

/** A step asking for a play of this card: dropped once the card is gone or the play is out of reach. */
function playStep(options: Parameters<typeof playCard>[0] & { possible?: (ctx: CoachCtx) => boolean }): CoachStep {
  const { possible, ...rest } = options;
  const reachable = possible ?? ((ctx: CoachCtx): boolean => legalPlays(ctx, rest.defId).length > 0);
  const step = playCard({ ...rest, when: (ctx) => reachable(ctx) && (rest.when === undefined || rest.when(ctx)) });
  return {
    ...step,
    moot: (ctx, since) => (since === null && inHand(ctx.view, rest.defId) === undefined) || outOfReach(ctx, reachable),
  };
}

const makeRadiant: CoachStep = {
  id: "make-radiant",
  title: "Make it Radiant",
  text: "Play Glowy Jelly Bean, then pick The Rock in your hand. The card you pick becomes Radiant.",
  kind: "act",
  anchor: { kind: "handCard", defId: GLOWY_JELLY_BEAN },
  when: (ctx) => myMain(ctx) && beanOnRock(ctx).length > 0,
  done: (ctx) => inHand(ctx.view, GLOWY_JELLY_BEAN) === undefined || rockRadiant(ctx.view),
  moot: (ctx) => outOfReach(ctx, (now) => beanOnRock(now).length > 0),
  expect: (action, ctx) => beanOnRock(ctx).some((play) => sameAction(play, action)),
};

const playRock: CoachStep = {
  id: "play-rock",
  title: "Pay the Tribute",
  text: (ctx) =>
    myTokens(ctx.view).length > 0
      ? "Play The Rock: pick a Felinor Token as its Tribute, then an empty zone. The token is sacrificed to pay for it."
      : "Play The Rock: pick your weakest unit as its Tribute, then an empty zone. That unit is sacrificed to pay for it.",
  kind: "act",
  anchor: { kind: "handCard", defId: THE_ROCK },
  when: (ctx) => myMain(ctx) && rockPlays(ctx).length > 0,
  done: (ctx) => inHand(ctx.view, THE_ROCK) === undefined,
  moot: (ctx, since) => (since === null && inHand(ctx.view, THE_ROCK) === undefined) || outOfReach(ctx, (now) => rockPlays(now).length > 0),
  expect: (action, ctx) => rockPlays(ctx).some((play) => sameAction(play, action)),
};

export const script: LessonScript = {
  lessonId: "advanced",
  steps: [
    // --- before the first turn: the mulligan -------------------------------------------------
    info({
      id: "welcome",
      title: "Tricks of the trade",
      text: "Your last lesson: the tricks good players use. The first one comes before the game even starts.",
      anchor: { kind: "prompt" },
      when: (ctx) => mulliganOpen(ctx.view),
      moot: (ctx) => pastMulligan(ctx.view),
    }),
    info({
      id: "mulligan-what",
      title: "The mulligan",
      text: "This is your opening hand. You may send cards back: you draw that many new ones, and the ones you sent back are shuffled into your deck.",
      anchor: { kind: "prompt" },
      when: (ctx) => mulliganOpen(ctx.view),
      moot: (ctx) => pastMulligan(ctx.view),
    }),
    mulliganAway({
      id: "mulligan",
      title: "Send one back",
      text: "Rule of thumb: send back cards you can't play in your first turns. The 4-mana 7/7 costs 4, so tap it to mark it Redraw, then press Ready.",
      defIds: [SEVEN_SEVEN],
    }),

    // --- your first turn: The Coin -------------------------------------------------------------
    info({
      id: "coin",
      title: "The Coin",
      text: "The AI went first. To make up for it, you started with one extra card and got The Coin: a free spell that gives 1 extra mana, this turn only.",
      anchor: { kind: "handCard", defId: COIN },
      when: (ctx) => myMain(ctx) && inHand(ctx.view, COIN) !== undefined,
      moot: (ctx, since) => since === null && pastMulligan(ctx.view) && inHand(ctx.view, COIN) === undefined,
    }),
    // Both belong to the first turn: once it has passed, "a turn early" is no longer true.
    {
      ...playStep({
        id: "play-coin",
        title: "Play The Coin",
        text: "Play The Coin now, so you have 2 mana on your very first turn.",
        defId: COIN,
      }),
      moot: (ctx, since) => (since === null && inHand(ctx.view, COIN) === undefined) || myTurnNumber(ctx.view) > 1,
    },
    {
      ...playStep({
        id: "play-fiender",
        title: "A turn early",
        text: "With 2 mana you can play Felinor Fiender, a 2-cost unit, a whole turn before you normally could.",
        defId: FELINOR_FIENDER,
      }),
      moot: (ctx, since) =>
        (since === null && inHand(ctx.view, FELINOR_FIENDER) === undefined) ||
        myTurnNumber(ctx.view) > 1 ||
        outOfReach(ctx, (now) => legalPlays(now, FELINOR_FIENDER).length > 0),
    },
    {
      ...restOfTurn("end-first"),
      text: (ctx) => {
        const move = nextMove(ctx);
        return move?.kind === "end" && ctx.view.you.mana.current === 0 ? "That is all your mana. End your turn." : moveText(ctx, move);
      },
    },

    // --- your second turn: tribes and tokens ---------------------------------------------------
    {
      ...info({
        id: "tribes",
        title: "Tribes",
        text: "Some cards belong to a tribe, named at the bottom of the card, like Felinor. Felinor Fiender adds the stats of all your Felinors to its own.",
        anchor: { kind: "unit", side: "you", defId: FELINOR_FIENDER },
        when: (ctx) => myMain(ctx) && fienderOnField(ctx),
      }),
      moot: (ctx) => outOfReach(ctx, fienderOnField),
    },
    playStep({
      id: "play-friend",
      title: "Felinor Tokens",
      text: "Play Friend of Felinors: it fills every empty zone on your side with a Felinor Token, a small unit the card makes.",
      defId: FRIEND_OF_FELINORS,
    }),
    info({
      id: "fiender-grew",
      title: "It grew",
      text: "Every Felinor Token is a Felinor, so Felinor Fiender counts them all. Look how much bigger it is now.",
      anchor: { kind: "unit", side: "you", defId: FELINOR_FIENDER },
      when: (ctx) => fienderOnField(ctx) && myTokens(ctx.view).length > 0,
      moot: (ctx, since) => since === null && (!fienderOnField(ctx) || myTokens(ctx.view).length === 0),
    }),
    restOfTurn("move-2"),

    // --- your third turn: Radiant ----------------------------------------------------------------
    info({
      id: "radiant",
      title: "Radiant cards",
      text: "Every card has an upgraded Radiant form with a gold face. Look at The Rock in your hand and note its stats.",
      anchor: { kind: "handCard", defId: THE_ROCK },
      when: (ctx) => myMain(ctx) && beanOnRock(ctx).length > 0,
      moot: (ctx) => outOfReach(ctx, (now) => beanOnRock(now).length > 0),
    }),
    makeRadiant,
    info({
      id: "radiant-after",
      title: "Upgraded",
      text: "The Rock is Radiant now: a gold face and stronger stats. Compare them with before. It stays Radiant for the rest of the game.",
      anchor: { kind: "handCard", defId: THE_ROCK },
      when: (ctx) => rockRadiant(ctx.view),
      moot: (ctx, since) => since === null && !rockRadiant(ctx.view),
    }),
    restOfTurn("move-3"),

    // --- your fourth turn: Tribute ---------------------------------------------------------------
    info({
      id: "tribute",
      title: "Tribute",
      text: "The Rock has Tribute 1: besides its mana, playing it costs one of your own units, which is sacrificed. A token is perfect for that.",
      anchor: { kind: "handCard", defId: THE_ROCK },
      when: (ctx) => myMain(ctx) && rockPlays(ctx).length > 0,
      moot: (ctx) => outOfReach(ctx, (now) => rockPlays(now).length > 0),
    }),
    playRock,
    info({
      id: "indestructible",
      title: "Indestructible",
      text: "The Rock is Indestructible: it never takes damage and can't be destroyed. Next turn it can attack.",
      anchor: { kind: "unit", side: "you", defId: THE_ROCK },
      when: (ctx) => unitOf(ctx.view, "you", THE_ROCK) !== undefined,
      moot: (ctx, since) => since === null && unitOf(ctx.view, "you", THE_ROCK) === undefined,
    }),
    restOfTurn("move-4"),

    // --- your fifth turn: the yellow glow ------------------------------------------------------
    // Taught on the card that glows, when it can be played: Reno glows from the turn the hero is
    // first hurt, but the coach names it only once the mana is there for it.
    playStep({
      id: "play-reno",
      title: "Glowing yellow",
      text: "Reno glows yellow: its condition is met right now. Your hero is below 30, so its Cry sets it back to 30. Play it.",
      defId: RENO,
      possible: renoReady,
    }),

    // --- the rest of the game: the coach names each move until it is won -------------------------
    yourMove({ id: "win", title: "Win the game", final: true }),
  ],
  tips: [
    tip({
      id: "fewer-felinors",
      title: "Fewer Felinors",
      text: "A Felinor Token is gone, so Felinor Fiender shrank: it counts only the Felinors you have right now. Tokens never go to the graveyard.",
      anchor: { kind: "unit", side: "you", defId: FELINOR_FIENDER },
      when: (ctx) =>
        fienderOnField(ctx) && freshOf(ctx, "destroyed").some((event) => event.defId === FELINOR_TOKEN && event.owner === ctx.view.viewer),
    }),
    // Another card's glow (Reno's is the `play-reno` step), shown when that card can be played.
    tip({
      id: "yellow-glow",
      title: "Glowing yellow",
      text: "A card in your hand glows yellow: its special condition is met right now, so it does its extra effect if you play it.",
      anchor: (ctx) => {
        const card = myHand(ctx.view).find((candidate) => candidate.defId !== RENO && candidate.conditionActive === true);
        return card === undefined ? null : { kind: "handCard", defId: card.defId };
      },
      when: (ctx) =>
        myMain(ctx) &&
        myHand(ctx.view).some((card) => card.defId !== RENO && card.conditionActive === true && legalPlays(ctx, card.defId).length > 0),
    }),
    tip({
      id: "saintess",
      title: "Radiant Saintess",
      text: "Radiant Saintess died, so all your other units became Radiant: gold faces and stronger stats.",
      anchor: { kind: "units", side: "you" },
      when: (ctx) =>
        freshOf(ctx, "destroyed").some((event) => event.defId === RADIANT_SAINTESS && event.owner === ctx.view.viewer) &&
        freshOf(ctx, "radiantSet").some((event) => event.zone.z === "field" && event.zone.player === ctx.view.viewer),
    }),
    tip({
      id: "board-full",
      title: "Board full",
      text: "All five of your zones are full, so you can't play another unit until one of them opens up.",
      anchor: { kind: "units", side: "you" },
      when: (ctx) =>
        myMain(ctx) &&
        unitsOf(ctx.view, "you").length === ctx.view.you.units.length &&
        // A hand card with stats is a Unit (CardView's `attack`, R243); one the mana would cover.
        myHand(ctx.view).some(
          (card) => card.attack !== undefined && card.cost <= ctx.view.you.mana.current && legalPlays(ctx, card.defId).length === 0,
        ),
    }),
  ],
};
