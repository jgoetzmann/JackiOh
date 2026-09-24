// Spec 13 — practice against the AI (SPEC §9.9, R187; docs/polish/3-ai.md B40).
//
// What it proves, in a real browser against `pnpm build:e2e` + `vite preview` and NO server:
//
//   * an anonymous `/practice` shows the setup screen;
//   * an Easy game with the human seated p2 shows `practice-thinking` while the AI mulligans and
//     then plays, and the AI's first turn changes the opponent's side of the board (mana, hand or
//     units) between the human's mulligan and the human's first turn;
//   * a few human turns end through the UI with no `action-error`;
//   * the game the browser played folds in Node, with the handicaps the page reports, to the
//     browser's own hash (`cy.task("replayHash")`, R187);
//   * conceding shows the result overlay with "Loss", and the practice result dialog with "Defeat";
//   * a Hard game with the human seated p2 shows `mana-opponent` at `data-max="2"` on the AI's
//     first turn (§9.9's `min(turns + 1, 7)`, R181), and its log, with the Hard handicap the page
//     reports, folds in Node to the browser's own hash (Easy stores no handicap, R180, so this is
//     the game that proves the handicapped replay end to end);
//   * nothing ever requests `/api` or opens a WebSocket.
//
// House rules (BUILD M8): seeds come from `seedFor`, every wait is `cy.settled()` or a retried
// assertion on a testid (never `cy.wait(ms)`), and every selector comes from support/testids.ts.
//
// Two harness choices, both about observing rather than steering:
//
//   * The DOM is recorded from the first byte (`installRecorder`, a MutationObserver installed in
//     `onBeforeLoad`). The AI's steps arrive faster than Cypress polls under `&pace=fast`, so
//     "the think indicator was shown while the AI mulliganed" is read off a record of every state
//     the page showed, not off whichever instant a retried `cy.get` happened to land on.
//   * The Hard game prefers reduced motion. The board holds a view back while its events animate
//     (BUILD M5-T4) and then jumps to the newest one, so with animations on, a short AI turn can be
//     over before its first view is ever drawn. Reduced motion draws every view as it arrives,
//     which is what "shows data-max=2 on the AI's first turn" needs to be observable at all.

import { seedFor, timeouts } from "../../support/config.ts";
import {
  ACTION_ERROR,
  ANIMATING,
  BOARD,
  CONCEDE,
  END_TURN,
  GAME,
  PRACTICE_DECK,
  PRACTICE_ERROR,
  PRACTICE_HUD,
  PRACTICE_RESULT,
  PRACTICE_SETUP,
  PRACTICE_START,
  PRACTICE_THINKING,
  PROMPT,
  PROMPT_SUBMIT,
  RESULT_OVERLAY,
  cardId,
  handCountId,
  manaId,
  practiceDifficultyId,
  promptOf,
  promptOptionId,
  ts,
  zoneId,
} from "../../support/testids.ts";
import type { Action, Lane, PlayerId } from "../../support/types.ts";

/** Every spec sets a seed (BUILD M8); `--expose seed=…` overrides it. */
const SEED = seedFor("13-practice");

/** Human turns played through the UI before the concede. */
const HUMAN_TURNS = 3;

/** The module worker loads the engine, the 109 card scripts and the AI before the first answer. */
const BOOT_TIMEOUT = 60_000;

/** A prompt the human must answer mid-turn (a cast-on-draw, R58) is rare; this bounds the loop. */
const PROMPT_BUDGET = 10;

type Difficulty = "easy" | "medium" | "hard";

// ---------------------------------------------------------------------------------------------
// the page's dev handle (apps/web/src/routes/practice.tsx, dev builds only)
// ---------------------------------------------------------------------------------------------

/** A structural subset of `PracticeDebug` (apps/web/src/practice/protocol.ts). */
type PracticeDebugLike = {
  seed: string;
  decks: [string[], string[]];
  handicaps: Partial<Record<PlayerId, unknown>>;
  log: Action[];
  state: unknown;
  hash: string;
  difficulty: Difficulty;
  humanSeat: PlayerId;
};

type PracticeHandleLike = {
  snapshot(): Promise<PracticeDebugLike>;
  readonly aiSeat: PlayerId | null;
  readonly thinking: boolean;
};

// ---------------------------------------------------------------------------------------------
// the recorder
// ---------------------------------------------------------------------------------------------

/** One state of the page, as far as this spec cares. */
type Sample = {
  thinking: boolean;
  turn: string | null;
  active: string | null;
  phase: string | null;
  opponentMax: string | null;
  opponentHand: string | null;
  opponentUnits: number;
  prompt: string | null;
};

type Recorder = { samples: Sample[]; sockets: number };

type PracticeWindow = { __jackiohPractice?: PracticeHandleLike; __practiceRecorder?: Recorder };

/** Any `card-<instanceId>`, the element a unit on the field renders as. */
const ANY_CARD = `[data-testid^="${cardId("")}"]`;

const LANES: readonly Lane[] = [1, 2, 3, 4, 5];

/** The units on the opponent's side: every card inside one of its five unit zones. */
function opponentUnitCount(doc: Document): number {
  return LANES.reduce(
    (count, lane) => count + (doc.querySelector(ts(zoneId("opponent", "units", lane)))?.querySelectorAll(ANY_CARD).length ?? 0),
    0,
  );
}

function sampleOf(doc: Document): Sample {
  const board = doc.querySelector(ts(BOARD));
  return {
    thinking: doc.querySelector(ts(PRACTICE_THINKING)) !== null,
    turn: board?.getAttribute("data-turn") ?? null,
    active: board?.getAttribute("data-active") ?? null,
    phase: board?.getAttribute("data-phase") ?? null,
    opponentMax: doc.querySelector(ts(manaId("opponent")))?.getAttribute("data-max") ?? null,
    opponentHand: doc.querySelector(ts(handCountId("opponent")))?.textContent?.trim() ?? null,
    opponentUnits: opponentUnitCount(doc),
    prompt: doc.querySelector(PROMPT)?.getAttribute("data-prompt-kind") ?? null,
  };
}

/**
 * Record every distinct page state from before the app's first script runs, and count every
 * WebSocket the page opens. Installed in `onBeforeLoad`, so nothing the page does escapes it.
 */
function installRecorder(win: Cypress.AUTWindow): void {
  const recorder: Recorder = { samples: [], sockets: 0 };
  (win as unknown as PracticeWindow).__practiceRecorder = recorder;

  const RealSocket = win.WebSocket;
  win.WebSocket = new Proxy(RealSocket, {
    construct(target, args: unknown[]) {
      recorder.sockets += 1;
      return Reflect.construct(target, args) as object;
    },
  });

  const record = (): void => {
    const next = sampleOf(win.document);
    const last = recorder.samples.at(-1);
    if (last === undefined || JSON.stringify(last) !== JSON.stringify(next)) recorder.samples.push(next);
  };
  new win.MutationObserver(record).observe(win.document, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
}

/** `prefers-reduced-motion: reduce`, for the one test that must see every view drawn (header). */
function preferReducedMotion(win: Cypress.AUTWindow): void {
  const real = win.matchMedia.bind(win);
  win.matchMedia = (query: string): MediaQueryList => {
    if (query.replace(/\s+/g, "") !== "(prefers-reduced-motion:reduce)") return real(query);
    return {
      matches: true,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  };
}

function recorder(): Cypress.Chainable<Recorder> {
  return cy.window({ log: false }).then((win) => {
    const found = (win as unknown as PracticeWindow).__practiceRecorder;
    expect(found, "the recorder installed in onBeforeLoad").to.not.eq(undefined);
    return found as Recorder;
  });
}

function practiceHandle(): Cypress.Chainable<PracticeHandleLike> {
  return cy
    .window({ timeout: timeouts.view })
    .should((win) => {
      expect((win as unknown as PracticeWindow).__jackiohPractice, "window.__jackiohPractice (dev builds)").to.not.eq(
        undefined,
      );
    })
    .then((win) => (win as unknown as PracticeWindow).__jackiohPractice as PracticeHandleLike);
}

// ---------------------------------------------------------------------------------------------
// driving the page
// ---------------------------------------------------------------------------------------------

function practiceUrl(seed: string, difficulty: Difficulty, seat: PlayerId): string {
  const params = new URLSearchParams({ seed, difficulty, deck: "random", seat, pace: "fast" });
  return `/practice?${params.toString()}`;
}

function visitPractice(url: string, options: { reducedMotion?: boolean } = {}): void {
  cy.visit(url, {
    onBeforeLoad(win) {
      installRecorder(win);
      if (options.reducedMotion === true) preferReducedMotion(win);
    },
  });
}

/** Any `prompt-option-<key>`. */
const ANY_PROMPT_OPTION = `[data-testid^="${promptOptionId("")}"]`;

/** A toggle already chosen: `aria-pressed` (Prompt.tsx) or `data-selected` (the board's spelling). */
function isPicked($option: JQuery<HTMLElement>): boolean {
  const marked = $option.closest("[aria-pressed], [data-selected]");
  const element = marked.length > 0 ? marked : $option;
  return element.attr("aria-pressed") === "true" || element.attr("data-selected") === "true";
}

/**
 * `cy.settled()` for a moment that can hand play to the AI. The AI takes its next step each time
 * the board has caught up with the last one (practice/controller.ts), so the board may go busy and
 * idle again for a whole AI turn, far longer than `timeouts.animation` allows for one action's
 * animations. The board must still settle; it gets as long as whole AI turns take, like
 * `waitForHuman`.
 */
function settledThroughAiTurn(): void {
  cy.get(ANIMATING, { timeout: timeouts.game, log: false }).should("not.exist");
}

/** R9 through the prompt UI: select every card to keep, then confirm. */
function keepWholeHand(): void {
  cy.get(promptOf("mulligan"), { timeout: BOOT_TIMEOUT }).should("be.visible");
  cy.get(promptOf("mulligan")).within(() => {
    cy.get(ANY_PROMPT_OPTION).each(($option) => {
      if (isPicked($option)) return;
      cy.wrap($option, { log: false }).click();
    });
    cy.get(ts(PROMPT_SUBMIT)).click();
  });
  settledThroughAiTurn();
}

/** Answer whatever prompt the human holds with its first option, confirming if it asks to be. */
function answerFirstOption(): void {
  cy.get(PROMPT).first().within(() => {
    cy.get(ANY_PROMPT_OPTION).first().click();
  });
  cy.get("body").then(($body) => {
    const submit = $body.find(ts(PROMPT_SUBMIT));
    if (submit.length > 0 && !submit.is(":disabled")) cy.wrap(submit.first()).click();
  });
  settledThroughAiTurn();
}

/** The opponent's side of the board as the human sees it: mana, hand size and units. */
function opponentSide(): Cypress.Chainable<string> {
  return cy.document({ log: false }).then((doc) => {
    const sample = sampleOf(doc);
    return JSON.stringify({ max: sample.opponentMax, hand: sample.opponentHand, units: sample.opponentUnits });
  });
}

type Waited = "turn" | "prompt" | "over";

/** Wait, as long as whole AI turns take, for the human's own main phase, a prompt, or the end. */
function waitForHuman(): Cypress.Chainable<Waited> {
  return cy
    .get("body", { timeout: timeouts.game })
    .should(($body) => {
      const board = $body.find(ts(BOARD));
      const endTurn = $body.find(ts(END_TURN));
      const myTurn =
        board.attr("data-active") === "you" &&
        board.attr("data-phase") === "main" &&
        endTurn.length > 0 &&
        !endTurn.is(":disabled");
      const prompt = $body.find(PROMPT).length > 0;
      const over = $body.find(ts(RESULT_OVERLAY)).length > 0;
      expect(myTurn || prompt || over, "the human's main phase, a prompt for the human, or a result").to.eq(true);
    })
    .then(($body): Waited => {
      if ($body.find(ts(RESULT_OVERLAY)).length > 0) return "over";
      if ($body.find(PROMPT).length > 0) return "prompt";
      return "turn";
    });
}

/** The human's main phase, answering any prompt on the way (at most PROMPT_BUDGET of them). */
function reachHumanTurn(prompts = PROMPT_BUDGET): void {
  waitForHuman().then((waited) => {
    expect(waited, "the game is still on when the human is due to act").to.not.eq("over");
    if (waited === "prompt") {
      expect(prompts, "the human's prompts run out").to.be.greaterThan(0);
      answerFirstOption();
      reachHumanTurn(prompts - 1);
      return;
    }
    cy.settled();
  });
}

function endHumanTurns(remaining: number): void {
  if (remaining === 0) return;
  reachHumanTurn();
  cy.get(ts(ACTION_ERROR)).should("not.exist");
  cy.get(ts(END_TURN)).should("not.be.disabled").click();
  settledThroughAiTurn();
  cy.get(ts(ACTION_ERROR)).should("not.exist");
  endHumanTurns(remaining - 1);
}

// ---------------------------------------------------------------------------------------------
// no server
// ---------------------------------------------------------------------------------------------

let apiRequests = 0;

beforeEach(() => {
  apiRequests = 0;
  cy.intercept({ url: "**/api/**" }, () => {
    apiRequests += 1;
  });
});

function expectNoServer(): void {
  cy.then(() => {
    expect(apiRequests, "requests to /api").to.eq(0);
  });
  recorder().then((recorded) => {
    expect(recorded.sockets, "WebSockets opened").to.eq(0);
  });
}

// ---------------------------------------------------------------------------------------------
// the spec
// ---------------------------------------------------------------------------------------------

describe("13 — practice against the AI, with no account and no server (§9.9, B40)", () => {
  it("B40 anonymous /practice shows setup", () => {
    visitPractice("/practice");

    cy.get(ts(PRACTICE_SETUP), { timeout: BOOT_TIMEOUT }).should("be.visible");
    for (const difficulty of ["easy", "medium", "hard"] as const) {
      cy.get(ts(practiceDifficultyId(difficulty))).should("have.attr", "type", "radio");
    }
    cy.get(ts(practiceDifficultyId("easy"))).should("be.checked");
    cy.get(ts(PRACTICE_DECK)).should(($select) => {
      const values = Array.from(($select[0] as HTMLSelectElement).options).map((option) => option.value);
      expect(values, "a random deck is always offered").to.include("random");
      expect(values.filter((value) => value.startsWith("saved:")), "no saved decks without an account").to.deep.eq([]);
    });
    cy.get(ts(PRACTICE_START)).should("be.visible");
    cy.get(ts(PRACTICE_HUD)).should("not.exist");
    cy.get(ts(PRACTICE_ERROR)).should("not.exist");

    expectNoServer();
  });

  it("B40 an Easy game seated p2: the AI thinks and plays, human turns end cleanly, the log replays, and a concede is a Loss", () => {
    visitPractice(practiceUrl(SEED, "easy", "p2"));

    cy.get(ts(PRACTICE_HUD), { timeout: BOOT_TIMEOUT })
      .should("have.attr", "data-difficulty", "easy")
      .and("have.attr", "data-human-seat", "p2")
      .and("have.attr", "data-ai-seat", "p1");
    cy.get(ts(GAME)).should("have.attr", "data-viewer", "p2");
    cy.get(ts(PRACTICE_SETUP)).should("not.exist");

    // p1 — the AI — answers the first mulligan (§2.1), so the human's prompt comes second.
    cy.get(promptOf("mulligan"), { timeout: BOOT_TIMEOUT }).should("be.visible");
    recorder().then((recorded) => {
      const firstPrompt = recorded.samples.findIndex((sample) => sample.prompt === "mulligan");
      expect(firstPrompt, "the human's mulligan was drawn").to.be.greaterThan(-1);
      expect(
        recorded.samples.slice(0, firstPrompt).some((sample) => sample.thinking),
        "practice-thinking showed while the AI mulliganed",
      ).to.eq(true);
    });

    opponentSide().then((beforeTheAiTurn) => {
      keepWholeHand();
      reachHumanTurn();
      cy.get(ts(ACTION_ERROR)).should("not.exist");
      opponentSide().then((afterTheAiTurn) => {
        expect(afterTheAiTurn, "the AI's first turn changed its mana, hand or board").to.not.eq(beforeTheAiTurn);
      });
    });

    endHumanTurns(HUMAN_TURNS);

    recorder().then((recorded) => {
      let lastMulligan = -1;
      recorded.samples.forEach((sample, index) => {
        if (sample.prompt === "mulligan") lastMulligan = index;
      });
      expect(
        recorded.samples.slice(lastMulligan + 1).some((sample) => sample.thinking),
        "practice-thinking showed while the AI played its turns",
      ).to.eq(true);
    });

    // Concede on the human's own turn: the overlay is viewer-relative (§10.8), so it says Loss.
    reachHumanTurn();
    cy.get(ts(CONCEDE)).should("not.be.disabled").click();
    cy.settled();
    cy.get(ts(RESULT_OVERLAY), { timeout: timeouts.view }).should("be.visible").and("contain.text", "Loss");
    // The practice route's own end screen says the same thing, and offers the next game.
    cy.get(ts(PRACTICE_RESULT), { timeout: timeouts.view })
      .should("be.visible")
      .and("have.attr", "data-outcome", "loss")
      .and("contain.text", "Defeat");
    cy.get(ts(ACTION_ERROR)).should("not.exist");

    // R187: the browser's game folds in Node, with the handicaps the page reports, to its own hash.
    practiceHandle()
      .then((handle) => handle.snapshot())
      .then((debug) => {
        expect(debug.seed, "the URL's seed reached the core").to.eq(SEED);
        expect(debug.difficulty).to.eq("easy");
        expect(debug.humanSeat).to.eq("p2");
        expect(debug.log.at(-1), "the game ended on the human's concede").to.include({ type: "concede", playerId: "p2" });
        expect(debug.log.some((action) => action.playerId === "p1"), "the AI acted").to.eq(true);

        cy.task<{ replayHash: string; browserHash: string; errors: unknown[] }>(
          "replayHash",
          {
            label: "13-practice",
            seed: debug.seed,
            decks: debug.decks,
            log: debug.log,
            state: debug.state,
            handicaps: debug.handicaps,
          },
          { timeout: timeouts.task },
        ).then((result) => {
          expect(result.errors, "the recorded log replays with no rejected action").to.deep.eq([]);
          expect(result.browserHash, "hashState of the page's final state is the page's own hash").to.eq(debug.hash);
          expect(result.replayHash, "the Node fold reaches the browser's final state").to.eq(result.browserHash);
        });
      });

    expectNoServer();
  });

  it("B40 a Hard game seated p2: the AI's first turn shows mana-opponent data-max=2", () => {
    visitPractice(practiceUrl(`${SEED}:hard`, "hard", "p2"), { reducedMotion: true });

    cy.get(ts(PRACTICE_HUD), { timeout: BOOT_TIMEOUT })
      .should("have.attr", "data-difficulty", "hard")
      .and("have.attr", "data-ai-seat", "p1");
    keepWholeHand();
    reachHumanTurn();

    recorder().then((recorded) => {
      const firstAiTurn = recorded.samples.find(
        (sample) => sample.turn === "1" && sample.active === "opponent" && sample.phase === "main",
      );
      expect(firstAiTurn, "the board showed the AI's first turn").to.not.eq(undefined);
      expect(firstAiTurn?.opponentMax, "Hard refreshes to min(turns + 1, 7) = 2 on its first turn (R181)").to.eq("2");
    });

    // R180, R187: a handicapped game replays too. Easy's handicap is a human's and is not stored
    // (R180), so it is this game that carries one through the worker's debug snapshot and the fold.
    practiceHandle()
      .then((handle) => handle.snapshot())
      .then((debug) => {
        expect(debug.difficulty).to.eq("hard");
        expect(debug.handicaps, "the AI seat's handicap reached the snapshot").to.have.property("p1");
        expect(debug.handicaps.p1, "Hard's handicap (R180)").to.deep.include({
          deckSize: 30,
          manaBonus: 1,
          manaCap: 7,
          extraOpeningCards: 1,
          extraDrawsPerTurn: 1,
        });
        expect(debug.decks[0], "the Hard AI's 30-card deck (R184)").to.have.length(30);
        expect(debug.log.some((action) => action.playerId === "p1"), "the AI acted").to.eq(true);

        cy.task<{ replayHash: string; browserHash: string; errors: unknown[] }>(
          "replayHash",
          {
            label: "13-practice-hard",
            seed: debug.seed,
            decks: debug.decks,
            log: debug.log,
            state: debug.state,
            handicaps: debug.handicaps,
          },
          { timeout: timeouts.task },
        ).then((result) => {
          expect(result.errors, "the Hard game's log replays with no rejected action").to.deep.eq([]);
          expect(result.browserHash, "hashState of the page's state is the page's own hash").to.eq(debug.hash);
          expect(result.replayHash, "the Node fold, handicaps included, reaches the browser's state").to.eq(
            result.browserHash,
          );
        });
      });

    expectNoServer();
  });
});
