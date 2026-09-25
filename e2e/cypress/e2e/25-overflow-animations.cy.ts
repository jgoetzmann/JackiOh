// Spec 25 — the three overflows shown on the board (SPEC §2.4, R315–R318, BUILD M5-T4's `fatigue`,
// `burned` and `libraryOverflow` rows), on /dev/hotseat, from both seats.
//
// Key assertions (R318's own words, and BUILD M5-T4's acceptance column for the three rows):
//
//   "`fatigue`: the owner's library pile shakes and dims as it comes up empty and a "Fatigue N"
//    badge (the event's `count`) rises from it, then the `damage` after it lands on the hero with
//    its number" — the library pile gains `data-animating="fatigue"` and its notice reads
//    "Fatigue N" (R315).
//   "`burned`: the card rises over its owner's hand under a "Hand full" tag … showing its face when
//    the viewer reads the event" — the hand's notice reads "Hand full" and names the card (R317).
//   "`libraryOverflow`: a "Library full" tag flashes on the owner's library pile and the refused
//    card, face or back by the same test, bounces off it" — the library pile gains
//    `data-animating="libraryOverflow"`, its notice reads "Library full" and shows the card (R316).
//   "The notices … stay up until the board shows the next view, as a damage number does."
//
// Three games, each its own seed, because each overflow needs resources SPEC's own game does not
// reach in a few turns. The fixtures carry a `handicap` (R180), which `cy.seedGame` injects for the
// seat and the dev route hands to `createGame`; the engine validates it (R184):
//
//   A. Fatigue (25-fatigue-a, a 4-card library). Seat 1's four cards are all in hand after its
//      turn-1 draw, so player-turn 3's draw is fatigue 1. Seat 2's end-turn starts that turn, so it
//      plays on SEAT 2's device: `pile-notice-opponent` reads "Fatigue 1" inside `library-opponent`
//      while `data-animating="fatigue"` is up, and `hero-opponent` pops a `.damage-pop` of 1. Then
//      seat 1 plays #5 Stockpile (draw 2) on its own device: fatigue 2, then fatigue 3, so
//      `pile-notice-you` reads "Fatigue 2" and then "Fatigue 3" (recorded, in that order), and the
//      hero pops 3.
//   B. Hand full (25-hand-full-a, six extra opening cards, R182). Seat 1 holds 10 = HAND_CAP after
//      its turn-1 draw, so player-turn 3's draw burns #6 Mana Well on seat 2's device:
//      `burn-notice-opponent` inside `hand-opponent` reads "Hand full" and `burn-card-opponent` is
//      the face of Mana Well (a burned card is public, R317). Then Stockpile, played from a full
//      hand, draws one card into it and burns #66 The Rock on seat 1's own device (`burn-notice-you`).
//   C. Library full (25-library-full-a, a 60-card library and 4 mana on turn 1). Seat 1 plays #33
//      Unstable Clone Machine, #4 Gary the Gambler (library 56 → 59) and #8 Mr. Vanilla, whose first
//      copy fills the library to LIBRARY_CAP and whose other two are never created (R80):
//      `pile-notice-you` reads "Library full" and `overflow-card-you` is Mr. Vanilla's face with
//      `data-outcome="notCreated"`. Then seat 2 plays #90 CN-Viral Injection into that full library:
//      `pile-notice-opponent` reads "Library full" and `overflow-card-opponent` is the CN-Virus's
//      face (a copy of nothing reads openly to both, R316), `notCreated`.
//
// Every notice is also asserted to be gone once `cy.settled()` has seen the board catch up, and every
// game ends with `cy.replayCheck`, which folds the browser's log in Node with the handicaps the page
// reports (R180) and compares hashes.
//
// Hotseat: the device is handed over by the seat switch, never by an end-turn (BUILD M5-T3), and a
// switch drains the animation queue, so a seat animates only what the actions taken while it held
// the device produced. That is why the turn-3 overflows play on seat 2's device: its end-turn is the
// action that started seat 1's turn.
//
// The seeds are the ones a headless search picked against these fixtures (the deck order in each
// file matters: `createGame` shuffles the list as given): any seed fatigues in A; B's deals Stockpile
// into seat 1's first ten cards and burns Mana Well and The Rock; C's deals the Clone Machine, Gary
// and Mr. Vanilla to seat 1 by turn 1 and CN-Viral Injection to seat 2 by turn 2. Each game asserts
// the precondition it relies on before acting, so a re-shuffle fails with a readable message.
//
// Screenshots: `--expose shots=1` adds a second pass that plays all three games again at 1280x720
// and at 390x844 with the effects at half speed (`FX_SETTINGS_KEY` speed 0.5, R201) and takes a
// `capture: "viewport"` shot of each notice while it is up, into
// `<E2E_ARTIFACTS>/screenshots/25-overflow-animations.cy.ts/25-overflow-animations/<size>/`. A plain
// run takes none.
//
// House rules (BUILD M8): seeds come from `seedFor`, there is no fixed `cy.wait(ms)` (every wait is
// `cy.settled()`, `cy.expectAnimating` or a retried assertion), every selector comes from
// support/testids.ts and every card name from support/cards.ts.
//
// Run it with:
//   pnpm build:e2e
//   pnpm --dir apps/web exec vite preview --port 5186 --strictPort
//   E2E_BASE_URL=http://localhost:5186 pnpm --dir e2e exec cypress run --browser chrome \
//     --spec cypress/e2e/25-overflow-animations.cy.ts
// and for the screenshots, a window big enough that headless Chrome does not crop them:
//   E2E_WINDOW_SIZE=1600,1200 E2E_BASE_URL=http://localhost:5186 pnpm --dir e2e exec cypress run \
//     --browser chrome --spec cypress/e2e/25-overflow-animations.cy.ts --expose shots=1

import { CARD_NAMES, TOKEN_NAMES } from "../../support/cards.ts";
import { FX_SETTINGS_KEY, constants, seedFor, timeouts } from "../../support/config.ts";
import {
  DAMAGE_POP,
  burnCardId,
  burnNoticeId,
  handCountId,
  handRegionId,
  heroId,
  libraryCountId,
  libraryId,
  overflowCardId,
  pileNoticeId,
  ts,
  type PileNoticeKind,
} from "../../support/testids.ts";
import type { PlayerId, Side } from "../../support/types.ts";

/** Every spec sets a seed (BUILD M8). One per game; `--expose seed=…` overrides all three at once. */
const SEEDS = {
  fatigue: seedFor("25-fatigue"),
  handFull: seedFor("25-hand-full-1"),
  libraryFull: seedFor("25-library-full-1093"),
};

/** Seat 2's deck in A and B: nothing in it resolves unless played, and The Coin keeps its turn open. */
const BYSTANDER = "08-do-nothing-b";

/** SPEC §8's name for card #index, which is what a face prints (BUILD M5-T1). */
function nameOf(index: number): string {
  const name = CARD_NAMES[index];
  if (name === undefined) throw new Error(`no SPEC §8 card #${String(index)}`);
  return name;
}

const STOCKPILE = nameOf(5);
const MANA_WELL = nameOf(6);
const THE_ROCK = nameOf(66);
const CLONE_MACHINE = nameOf(33);
const GARY = nameOf(4);
const VANILLA = nameOf(8);
const INJECTION = nameOf(90);
const CN_VIRUS = TOKEN_NAMES["90.1"] ?? "CN-Virus";

// ---------------------------------------------------------------------------------------------
// the screenshot pass
// ---------------------------------------------------------------------------------------------

/** `--expose shots=1`: the second pass, at both sizes, with screenshots. */
const SHOTS = ["1", "true"].includes(String(Cypress.expose("shots") ?? ""));

/** `phone`: the hand fans out and overlaps at this size (see `handClick`). */
type Viewport = { label: string; width: number; height: number; phone: boolean };
/** BUILD M5-T1's two sizes: the desktop board and the phone. */
const VIEWPORTS: readonly Viewport[] = [
  { label: "1280x720", width: 1280, height: 720, phone: false },
  { label: "390x844", width: 390, height: 844, phone: true },
];
/** R201: half speed, the slowest the setting allows, so a notice is still up when the shot is taken. */
const SHOT_FX = { speed: 0.5, intensity: "normal", motion: "system" } as const;

/**
 * How a hand card is clicked at this size. At 390x844 a full hand fans out and overlaps, so the
 * click goes where a player's thumb would: the part of the card that shows (`visiblePart`).
 */
function handClick(viewport: Viewport | null): { visiblePart?: boolean } {
  return viewport?.phone === true ? { visiblePart: true } : {};
}

/**
 * A shot of the notice on screen, when this game is part of the screenshot pass. With `playing`,
 * the shot waits for that notice's own entry to be in flight (`data-playing="true"`), so it catches
 * the card mid-motion rather than the tag at rest; without, it is taken as it stands (the fatigue
 * shots wait for the hit's number instead, which lands after the badge's entry).
 */
type Shoot = (name: string, playing?: string) => void;
const NO_SHOTS: Shoot = () => undefined;

function shooterFor(viewport: Viewport): Shoot {
  return (name, playing) => {
    if (playing !== undefined) {
      cy.get(ts(playing), { timeout: timeouts.animation }).should("have.attr", "data-playing", "true");
    }
    // `disableTimersAndAnimations` would jump every CSS animation to its end for the shot, and a
    // burned or refused card ends at opacity 0: the shot is of the motion as it stands.
    cy.screenshot(`25-overflow-animations/${viewport.label}/${name}`, {
      capture: "viewport",
      disableTimersAndAnimations: false,
    });
  };
}

// ---------------------------------------------------------------------------------------------
// the notice recorder
// ---------------------------------------------------------------------------------------------

/**
 * Every state an overflow notice was drawn in, in order, recorded by a MutationObserver in the page
 * (spec 17's recorder does the same for the showcase). A retried `should` sees whatever is up when
 * it looks; this is how the spec knows "Fatigue 2" was drawn before "Fatigue 3", and that a notice's
 * motion ran (`data-playing="true"`) rather than only its resting tag.
 */
type NoticeState = {
  testid: string;
  kind: string | null;
  playing: boolean;
  text: string;
  face: string | null;
  outcome: string | null;
};
type NoticeRecorder = { seen: NoticeState[] };
type RecordingWindow = { __overflowNotices?: NoticeRecorder };

const NOTICE_PREFIXES = ["pile-notice-", "burn-notice-"] as const;
const NOTICE_CARD_PREFIXES = ["overflow-card-", "burn-card-"] as const;
const startsWithAny = (prefixes: readonly string[]): string =>
  prefixes.map((prefix) => `[data-testid^="${prefix}"]`).join(", ");

function installNoticeRecorder(win: Cypress.AUTWindow): void {
  const host = win as unknown as RecordingWindow;
  if (host.__overflowNotices !== undefined) return;
  const recorder: NoticeRecorder = { seen: [] };
  host.__overflowNotices = recorder;
  const last = new Map<string, string>();

  const record = (): void => {
    const present = new Set<string>();
    for (const element of Array.from(win.document.querySelectorAll(startsWithAny(NOTICE_PREFIXES)))) {
      const testid = element.getAttribute("data-testid") ?? "";
      present.add(testid);
      const card = element.querySelector(startsWithAny(NOTICE_CARD_PREFIXES));
      const state: NoticeState = {
        testid,
        kind: element.getAttribute("data-kind"),
        playing: element.getAttribute("data-playing") === "true",
        text: element.textContent ?? "",
        face: card?.getAttribute("data-face") ?? null,
        outcome: card?.getAttribute("data-outcome") ?? null,
      };
      const key = JSON.stringify(state);
      if (last.get(testid) === key) continue;
      last.set(testid, key);
      recorder.seen.push(state);
    }
    // A notice that went away records again the next time it mounts, even with the same text.
    for (const testid of Array.from(last.keys())) if (!present.has(testid)) last.delete(testid);
  };
  new win.MutationObserver(record).observe(win.document, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  record();
}

/** Forget what was recorded so far, so the next action's notices are read on their own. */
function clearNotices(): void {
  cy.window({ log: false }).then((win) => {
    const recorder = (win as unknown as RecordingWindow).__overflowNotices;
    expect(recorder, "the notice recorder is installed").to.not.eq(undefined);
    if (recorder !== undefined) recorder.seen.length = 0;
  });
}

/** What the recorder saw of one notice since the last `clearNotices`. */
function recorded(testid: string): Cypress.Chainable<NoticeState[]> {
  return cy.window({ log: false }).then((win) => {
    const seen = (win as unknown as RecordingWindow).__overflowNotices?.seen ?? [];
    return seen.filter((state) => state.testid === testid);
  });
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

type Game = { seed: string; a: string; b: string };

/** `cy.seedGame`, with the recorder installed and, for a shot, the viewport and the slow effects. */
function startGame(game: Game, viewport: Viewport | null): void {
  if (viewport !== null) cy.viewport(viewport.width, viewport.height);
  cy.seedGame({
    ...game,
    onBeforeLoad(win) {
      if (viewport !== null) {
        try {
          win.localStorage.setItem(FX_SETTINGS_KEY, JSON.stringify(SHOT_FX));
        } catch (error) {
          Cypress.log({ name: "fx speed", message: `localStorage unavailable: ${String(error)}` });
        }
      }
      installNoticeRecorder(win);
    },
  });
}

/** BUILD M5-T3: the device is handed over, never taken, so hand it to `seat` if the other holds it. */
function holdDevice(seat: PlayerId): void {
  cy.jackioh().then((handle) => {
    if (handle.seat !== seat) cy.handOver();
  });
  cy.jackioh().its("seat").should("eq", seat);
}

/** A pile's or a hand's count, read off the number the board prints. */
function expectCount(testid: string, count: number): void {
  cy.get(ts(testid), { timeout: timeouts.view }).should("have.text", String(count));
}

/** The notice on `side`'s library pile, of `kind`, reading `text` (retried until it does). */
function expectPileNotice(side: Side, kind: PileNoticeKind, text: string): void {
  cy.get(ts(libraryId(side)), { timeout: timeouts.animation })
    .find(ts(pileNoticeId(side)), { timeout: timeouts.animation })
    .should("have.attr", "data-kind", kind)
    .and("contain.text", text);
}

/** The card a "Library full" notice shows: its face, naming `name`, and what became of it. */
function expectOverflowCard(side: Side, name: string, outcome: "notCreated" | "graveyard" | "ceased"): void {
  cy.get(ts(pileNoticeId(side)))
    .find(ts(overflowCardId(side)), { timeout: timeouts.animation })
    .should("have.attr", "data-face", "face")
    .and("have.attr", "data-outcome", outcome)
    .and("contain.text", name);
}

/** The "Hand full" notice over `side`'s hand, its card's face naming `name`. */
function expectBurnNotice(side: Side, name: string): void {
  cy.get(ts(handRegionId(side)), { timeout: timeouts.animation })
    .find(ts(burnNoticeId(side)), { timeout: timeouts.animation })
    .should("contain.text", "Hand full");
  cy.get(ts(burnNoticeId(side)))
    .find(ts(burnCardId(side)))
    .should("have.attr", "data-face", "face")
    .and("contain.text", name);
}

/** The hit a fatigue draw lands on the hero, as BUILD M5-T4's `damage` row pops it. */
function expectDamagePop(side: Side, amount: number): void {
  cy.get(ts(heroId(side)), { timeout: timeouts.animation })
    .find(DAMAGE_POP, { timeout: timeouts.animation })
    .should("contain.text", String(amount));
}

/** "Stay up until the board shows the next view": once the runner has drained, the notice is gone. */
function expectNoticesGone(side: Side): void {
  cy.settled();
  cy.get(ts(pileNoticeId(side)), { timeout: timeouts.animation }).should("not.exist");
  cy.get(ts(burnNoticeId(side)), { timeout: timeouts.animation }).should("not.exist");
}

/** The recorder saw the notice's motion run, not only its resting tag (`data-playing="true"`). */
function expectPlayed(testid: string): void {
  recorded(testid).then((states) => {
    expect(states.length, `${testid} was drawn`).to.be.greaterThan(0);
    expect(
      states.some((state) => state.playing),
      `${testid} carried data-playing="true" while its entry ran`,
    ).to.eq(true);
  });
}

// ---------------------------------------------------------------------------------------------
// the three games
// ---------------------------------------------------------------------------------------------

/** A. R315: fatigue 1 on the other seat's device, then fatigue 2 and 3 on the owner's own. */
function fatigue(viewport: Viewport | null, shoot: Shoot): void {
  startGame({ seed: SEEDS.fatigue, a: "25-fatigue-a", b: BYSTANDER }, viewport);

  // Precondition: a 4-card library (the handicap's deckSize, R184) is empty once the three opening
  // cards and the turn-1 draw are in hand, so the next draw is the first from an empty library.
  holdDevice("p1");
  expectCount(libraryCountId("you"), 0);
  expectCount(handCountId("you"), 4);
  cy.endTurn();

  // Seat 2's end-turn starts player-turn 3, whose draw is seat 1's fatigue 1: seat 2's device plays it.
  holdDevice("p2");
  clearNotices();
  cy.endTurn({
    handOver: false,
    expectAnimating: "fatigue",
    during: () => {
      expectPileNotice("opponent", "fatigue", "Fatigue 1");
      expectDamagePop("opponent", 1);
      shoot("fatigue-opponent");
    },
  });
  expectNoticesGone("opponent");
  expectPlayed(pileNoticeId("opponent"));

  // Seat 1 draws two from its empty library with Stockpile: fatigue 2, then fatigue 3, on its own device.
  holdDevice("p1");
  clearNotices();
  cy.playByName(STOCKPILE, {
    ...handClick(viewport),
    expectAnimating: "fatigue",
    during: () => {
      expectPileNotice("you", "fatigue", "Fatigue 3");
      expectDamagePop("you", 3);
      shoot("fatigue-you");
    },
  });
  expectNoticesGone("you");
  recorded(pileNoticeId("you")).then((states) => {
    const counts = states
      .map((state) => /Fatigue (\d+)/.exec(state.text)?.[1])
      .filter((count): count is string => count !== undefined)
      .filter((count, at, all) => at === 0 || all[at - 1] !== count);
    expect(counts, "R315: each fatigue draw's badge, in draw order").to.deep.eq(["2", "3"]);
  });
  expectPlayed(pileNoticeId("you"));

  cy.replayCheck("25-fatigue");
}

/** B. R317: a draw into a full hand burns on the other seat's device, then Stockpile's on the owner's. */
function handFull(viewport: Viewport | null, shoot: Shoot): void {
  startGame({ seed: SEEDS.handFull, a: "25-hand-full-a", b: BYSTANDER }, viewport);

  // Precondition: 3 + 6 opening cards (R182) and the turn-1 draw are HAND_CAP, Stockpile among them.
  holdDevice("p1");
  expectCount(handCountId("you"), constants.HAND_CAP);
  cy.handCardByName(STOCKPILE);
  cy.endTurn();

  // Seat 2's end-turn starts player-turn 3: seat 1 draws into a full hand and Mana Well burns.
  holdDevice("p2");
  clearNotices();
  cy.endTurn({
    handOver: false,
    expectAnimating: "burned",
    during: () => {
      shoot("hand-full-opponent", burnNoticeId("opponent"));
      expectBurnNotice("opponent", MANA_WELL);
    },
  });
  expectNoticesGone("opponent");
  expectPlayed(burnNoticeId("opponent"));
  expectCount(handCountId("opponent"), constants.HAND_CAP);

  // Stockpile leaves the hand, so its first draw refills it to HAND_CAP and its second (The Rock) burns.
  holdDevice("p1");
  clearNotices();
  cy.playByName(STOCKPILE, {
    ...handClick(viewport),
    expectAnimating: "burned",
    during: () => {
      shoot("hand-full-you", burnNoticeId("you"));
      expectBurnNotice("you", THE_ROCK);
    },
  });
  expectNoticesGone("you");
  expectPlayed(burnNoticeId("you"));
  expectCount(handCountId("you"), constants.HAND_CAP);

  cy.replayCheck("25-hand-full");
}

/** C. R80, R316: a full library refuses the Clone Machine's copies, then the other seat's CN-Virus. */
function libraryFull(viewport: Viewport | null, shoot: Shoot): void {
  startGame({ seed: SEEDS.libraryFull, a: "25-library-full-a", b: "25-library-full-b" }, viewport);

  // Precondition: 60 cards less the opening 3 and the turn-1 draw, and the three cards this plays.
  holdDevice("p1");
  expectCount(libraryCountId("you"), constants.LIBRARY_CAP - 4);
  for (const name of [CLONE_MACHINE, GARY, VANILLA]) cy.handCardByName(name);

  cy.playByName(CLONE_MACHINE, { ...handClick(viewport), zone: { side: "you", row: "backrow", lane: 1 } });
  // #33 does not copy its own play (R119); Gary's three copies take the library to 59.
  cy.playByName(GARY, { ...handClick(viewport), zone: { side: "you", row: "units", lane: 1 } });
  expectCount(libraryCountId("you"), constants.LIBRARY_CAP - 1);

  // Mr. Vanilla's first copy fills the library; the other two are never created (R80).
  clearNotices();
  cy.playByName(VANILLA, {
    ...handClick(viewport),
    zone: { side: "you", row: "units", lane: 2 },
    expectAnimating: "libraryOverflow",
    during: () => {
      shoot("library-full-you", pileNoticeId("you"));
      expectPileNotice("you", "libraryFull", "Library full");
      expectOverflowCard("you", VANILLA, "notCreated");
    },
  });
  expectNoticesGone("you");
  expectPlayed(pileNoticeId("you"));
  expectCount(libraryCountId("you"), constants.LIBRARY_CAP);

  // Seat 2 shuffles a CN-Virus into that full library, which refuses it on seat 2's device.
  cy.endTurn();
  holdDevice("p2");
  cy.handCardByName(INJECTION);
  clearNotices();
  cy.playByName(INJECTION, {
    ...handClick(viewport),
    expectAnimating: "libraryOverflow",
    during: () => {
      shoot("library-full-opponent", pileNoticeId("opponent"));
      expectPileNotice("opponent", "libraryFull", "Library full");
      expectOverflowCard("opponent", CN_VIRUS, "notCreated");
    },
  });
  expectNoticesGone("opponent");
  expectPlayed(pileNoticeId("opponent"));
  expectCount(libraryCountId("opponent"), constants.LIBRARY_CAP);

  cy.replayCheck("25-library-full");
}

// ---------------------------------------------------------------------------------------------

describe("Spec 25 — fatigue, a full hand and a full library on the board (R315–R318)", () => {
  it("R315 fatigue: 'Fatigue 1' and the hit on the other seat's device, 'Fatigue 2' then 'Fatigue 3' on the owner's", () => {
    fatigue(null, NO_SHOTS);
  });

  it("R317 hand full: the burned card's face under 'Hand full', on the other seat's device and then the owner's", () => {
    handFull(null, NO_SHOTS);
  });

  it("R316 library full: the refused copy under 'Library full', the owner's own play and then the other seat's CN-Virus", () => {
    libraryFull(null, NO_SHOTS);
  });
});

// The screenshot pass (see the header): the same three games at both sizes, with the effects at half
// speed, shooting each notice while it is up. Only with `--expose shots=1`.
if (SHOTS) {
  describe("Spec 25 — screenshots of each overflow mid-flight", () => {
    for (const viewport of VIEWPORTS) {
      it(`R318 at ${viewport.label}: fatigue`, () => {
        fatigue(viewport, shooterFor(viewport));
      });
      it(`R318 at ${viewport.label}: hand full`, () => {
        handFull(viewport, shooterFor(viewport));
      });
      it(`R318 at ${viewport.label}: library full`, () => {
        libraryFull(viewport, shooterFor(viewport));
      });
    }
  });
}
