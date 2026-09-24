// Spec 17 — the opponent's play held up, and the log and the piles looked into (client polish,
// SPEC §10.8, §10.10, R97, R202).
//
// What it proves, in a real browser against `pnpm build:e2e` + `vite preview` and no server:
//
//   * a card the opponent plays is held up beside the field (`showcase`) for about a second
//     (SHOWCASE_HOLD_MS, 1 s at the default effects speed), click-through, and then goes by itself;
//     the polite live region says what was played. On `/dev/hotseat` the arriving seat catches up
//     on the plays made since it last held the device; the viewer's own plays are never held up;
//   * a log line that names a card is a button (`log-card`): a resting mouse opens the card's face
//     (`inspect-hover`), and a click opens it in the sheet, which Escape closes;
//   * a graveyard (and so an exile pile, the same component) that holds cards is browsable on both
//     seats: a resting mouse shows its count and its newest faces (`inspect-list-hover`), and a click
//     opens every card, newest first, in a dialog (`inspect-list-sheet`) where a face opens large;
//     the library, which is hidden, is not browsable;
//   * on `/practice` (normal pacing, not `?pace=fast`), the AI's played card is held up for about a
//     second and the AI takes no step while it is up (routes/practice.tsx holds it on
//     `data-showcase`, as it does on `data-speaking`).
//
// House rules (BUILD M8): seeds come from `seedFor`, there is no fixed `cy.wait(ms)` (every wait is
// `cy.settled()` or a retried assertion), and every selector comes from support/testids.ts.
//
// How long the showcase stood is read off a recorder, not off Cypress polling: a MutationObserver
// installed in the page timestamps every showcase as it appears and as it goes (the page's own
// `performance.now()`), so "about a second" is measured where it happened.
//
// Run it with:
//   pnpm build:e2e
//   pnpm --dir apps/web exec vite preview --port 5182 --strictPort
//   E2E_BASE_URL=http://localhost:5182 pnpm --dir e2e exec cypress run --browser chrome \
//     --spec cypress/e2e/17-card-showcase-and-hovers.cy.ts

import { CARD_NAMES } from "../../support/cards.ts";
import { seedFor, timeouts } from "../../support/config.ts";
import {
  BOARD,
  BROWSABLE,
  END_TURN,
  INSPECT_CLOSE,
  INSPECT_HOVER,
  INSPECT_LIST_BACK,
  INSPECT_LIST_CARD,
  INSPECT_LIST_COUNT,
  INSPECT_LIST_DETAIL,
  INSPECT_LIST_HOVER,
  INSPECT_LIST_SHEET,
  INSPECT_SHEET,
  LEGAL,
  LOG,
  LOG_CARD,
  PROMPT,
  PROMPT_SUBMIT,
  SHOWCASE,
  SHOWCASE_BACK,
  SHOWCASE_CAPTION,
  SHOWCASE_FACE,
  SHOWCASE_LIVE,
  graveyardCountId,
  handCardId,
  promptOf,
  promptOptionId,
  ts,
  zoneId,
} from "../../support/testids.ts";
import type { GameStateLike, Lane, PlayerId, Row } from "../../support/types.ts";

/** Every spec sets a seed (BUILD M8); `--expose seed=…` overrides it. */
const SEED = seedFor("17-showcase");
const DECK_A = "01-aggro-a";
const DECK_B = "01-aggro-b";

/**
 * Spec 03's decks and seed: player 2 holds #41 Sheepish on its first turn and sets it face down
 * (R227). The seed is spec 03's own, so the trap is in hand exactly when that spec relies on it.
 */
const TRAP_SEED = seedFor("03-sheep-19");
const TRAP_DECK_A = "03-plays-a";
const TRAP_DECK_B = "03-sheepish-b";
const TRAP_NAME = "Sheepish";

/**
 * The catalog's Units and Spells among 01-aggro-a and 01-aggro-b (packages/cards/catalog.json).
 * Every card in those two decks is choice-free (spec 01), so a play is a hand click plus, for a
 * Unit, a zone click. A Spell resolves into its owner's graveyard; the Field Spells stay out.
 */
const UNIT_DEF_IDS: ReadonlySet<string> = new Set([
  "core-001", "core-003", "core-008", "core-011", "core-015", "core-019", "core-020", "core-025",
  "core-032", "core-045", "core-053", "core-056", "core-077", "core-081", "core-089", "core-091",
  "core-092",
]);
const SPELL_DEF_IDS: ReadonlySet<string> = new Set(["core-005", "core-010", "core-062"]);

/** Player-turns to wait for the client to offer a card of a kind. A 0- to 2-cost card lands well inside it. */
const TURN_BUDGET = 8;

/**
 * SHOWCASE_HOLD_MS (apps/web/src/game/showcase/constants.ts) is 1 s at the default effects speed.
 * The measured hold may land a little either side of it (timers, frames, a busy CI runner), and
 * "about a second" is what is asserted.
 */
const HOLD_MIN_MS = 700;
const HOLD_MAX_MS = 2_500;

/** The practice worker loads the engine, the card scripts and the AI before its first answer. */
const BOOT_TIMEOUT = 60_000;
/** Human turns the practice test may end while waiting for the AI to play a card. */
const PRACTICE_TURN_BUDGET = 6;
/** Prompts the human may have to answer on the way (a cast-on-draw, R58, is rare). */
const PROMPT_BUDGET = 10;

const LANES: readonly Lane[] = [1, 2, 3, 4, 5];
const ROWS: readonly Row[] = ["units", "backrow"];

/** A catalog id's printed name: `core-032` is SPEC §8 #32. */
function nameOf(defId: string): string {
  const name = CARD_NAMES[Number(defId.replace(/^core-/, ""))];
  expect(name, `SPEC §8 names ${defId}`).to.not.eq(undefined);
  return name ?? defId;
}

// ---------------------------------------------------------------------------------------------
// the recorder
// ---------------------------------------------------------------------------------------------

type Shown = {
  seq: string | null;
  kind: string | null;
  def: string | null;
  text: string;
  pointerEvents: string;
  shownAt: number;
  goneAt: number | null;
};

/** A practice step: the newest event the page's snapshot carries changed. */
type Step = { at: number; key: string };

type Recorder = { showcases: Shown[]; steps: Step[] };

type PracticeHandleLike = { readonly view: { events: unknown[] } | null; readonly aiSeat: PlayerId | null };

type RecordingWindow = { __showcaseRecorder?: Recorder; __jackiohPractice?: PracticeHandleLike };

/**
 * Timestamp every showcase as it appears and as it goes, and (on /practice) every change of the
 * newest event in the page's snapshot, from inside the page. Safe to install twice.
 */
function installRecorder(win: Cypress.AUTWindow): void {
  const host = win as unknown as RecordingWindow;
  if (host.__showcaseRecorder !== undefined) return;
  const recorder: Recorder = { showcases: [], steps: [] };
  host.__showcaseRecorder = recorder;
  let open: Shown | null = null;
  let lastStep = "";

  const record = (): void => {
    const now = win.performance.now();
    const element = win.document.querySelector(ts(SHOWCASE));
    const seq = element?.getAttribute("data-seq") ?? null;
    if (open !== null && (element === null || open.seq !== seq)) {
      open.goneAt = now;
      open = null;
    }
    if (element !== null && open === null) {
      open = {
        seq,
        kind: element.getAttribute("data-showcase"),
        def: element.getAttribute("data-showcase-def"),
        text: element.textContent ?? "",
        pointerEvents: win.getComputedStyle(element).pointerEvents,
        shownAt: now,
        goneAt: null,
      };
      recorder.showcases.push(open);
    }
    const events = host.__jackiohPractice?.view?.events;
    if (events !== undefined) {
      const key = `${String(events.length)}:${JSON.stringify(events[events.length - 1] ?? null)}`;
      if (key !== lastStep) {
        lastStep = key;
        recorder.steps.push({ at: now, key });
      }
    }
  };
  new win.MutationObserver(record).observe(win.document, { subtree: true, childList: true, attributes: true, characterData: true });
  record();
}

function recorder(): Cypress.Chainable<Recorder> {
  return cy.window({ log: false }).then((win) => {
    const found = (win as unknown as RecordingWindow).__showcaseRecorder;
    expect(found, "the showcase recorder").to.not.eq(undefined);
    return found as Recorder;
  });
}

/** Every showcase of `defId` has come and gone, and there is exactly `count` of them. */
function expectHeldAboutASecond(defId: string, count = 1): void {
  cy.window({ timeout: timeouts.animation }).should((win) => {
    const recorded = (win as unknown as RecordingWindow).__showcaseRecorder;
    const shown = (recorded?.showcases ?? []).filter((entry) => entry.def === defId);
    expect(shown, `showcases of ${defId}`).to.have.length(count);
    for (const entry of shown) {
      expect(entry.goneAt, `the showcase of ${defId} went by itself`).to.not.eq(null);
      const held = (entry.goneAt ?? 0) - entry.shownAt;
      expect(held, `the showcase of ${defId} stood for about a second`).to.be.within(HOLD_MIN_MS, HOLD_MAX_MS);
      expect(entry.pointerEvents, "the showcase is click-through").to.eq("none");
    }
  });
}

// ---------------------------------------------------------------------------------------------
// hotseat: playing a card of a kind through the UI (the pattern spec 15 uses)
// ---------------------------------------------------------------------------------------------

type HandCard = { id: string; defId: string };

function handOf(state: GameStateLike, player: PlayerId): HandCard[] {
  const side = state.players[player] as { hand?: HandCard[] };
  return side.hand ?? [];
}

/** The first of `testids` the client marks `data-legal="true"` (its copy of `legalActions`). */
function firstLegal(testids: readonly string[]): Cypress.Chainable<string | null> {
  return cy.get("body", { log: false }).then(($body) => {
    const found = testids.find((testid) => $body.find(`${ts(testid)}${LEGAL}`).length > 0);
    return cy.wrap(found ?? null, { log: false });
  });
}

/** BUILD M5-T3: a hotseat device is handed over, so make sure it is on the seat that has to act. */
function ensureSeat(player: PlayerId): void {
  cy.jackioh().then((handle) => {
    if (handle.seat !== undefined && handle.seat !== player) cy.handOver();
  });
}

type Played = { instanceId: string; defId: string; seat: PlayerId | "" };

/**
 * Play the first card of `kinds` the client offers from the active seat's hand: a hand click, then
 * the first highlighted zone of the player's own side if the play asks for one. Ends turns (handing
 * the device over) until one is offered.
 */
function playOffered(kinds: ReadonlySet<string>, played: Played, turnsLeft = TURN_BUDGET): void {
  cy.gameState().then((state) => {
    expect(turnsLeft, "the client offered such a card inside the turn budget").to.be.greaterThan(0);
    expect(state.result, "the game is still running").to.eq(null);
    const seat = state.active;
    ensureSeat(seat);
    const cards = handOf(state, seat).filter((card) => kinds.has(card.defId));

    firstLegal(cards.map((card) => handCardId(card.id))).then((testid) => {
      if (testid === null) {
        // R82: a turn with nothing left to do may already have ended itself.
        cy.gameState().then((now) => {
          if (now.active === seat) cy.endTurn();
          else cy.handOver();
        });
        playOffered(kinds, played, turnsLeft - 1);
        return;
      }
      const card = cards.find((entry) => handCardId(entry.id) === testid);
      played.instanceId = card?.id ?? "";
      played.defId = card?.defId ?? "";
      played.seat = seat;

      cy.get(ts(testid)).click();
      cy.settled();
      // R81: the zone travels in the `play` action and a board click finishes it (BUILD M5-T2).
      firstLegal(ROWS.flatMap((row) => LANES.map((lane) => zoneId("you", row, lane)))).then((zone) => {
        if (zone !== null) {
          cy.get(ts(zone)).click();
          cy.settled();
        }
      });
      cy.get(ts(testid)).should("not.exist");
    });
  });
}

// ---------------------------------------------------------------------------------------------
// practice
// ---------------------------------------------------------------------------------------------

/** Any `prompt-option-<key>`. */
const ANY_PROMPT_OPTION = `[data-testid^="${promptOptionId("")}"]`;

function practiceUrl(seed: string): string {
  // Normal pacing on purpose: `?pace=fast` releases the AI without waiting for the showcase.
  const params = new URLSearchParams({ seed, difficulty: "easy", deck: "random", seat: "p2" });
  return `/practice?${params.toString()}`;
}

type Waited = "showcase" | "turn" | "prompt" | "over";

type PracticeView = { active: PlayerId; phase: string; pending: { forYou: boolean } | null; result: unknown; events: unknown[] };

function practiceView(win: Cypress.AUTWindow): PracticeView | null {
  return ((win as unknown as RecordingWindow).__jackiohPractice?.view ?? null) as PracticeView | null;
}

function aiHasPlayed(win: Cypress.AUTWindow): boolean {
  return ((win as unknown as RecordingWindow).__showcaseRecorder?.showcases ?? []).some(
    (entry) => entry.kind === "played" && entry.goneAt !== null,
  );
}

/**
 * Wait, as long as whole AI turns take, for a showcase that has come and gone, the human's main
 * phase, a prompt for the human, or the end. The human's turn and prompt are read off the newest
 * snapshot AND a board that has caught up with it (nothing animating), so an answer is never sent
 * twice for one prompt.
 */
function waitForShowcaseOrHuman(): Cypress.Chainable<Waited> {
  const classify = (win: Cypress.AUTWindow): Waited | null => {
    if (aiHasPlayed(win)) return "showcase";
    const view = practiceView(win);
    const doc = win.document;
    if (view === null) return null;
    if (view.result !== null) return "over";
    if (doc.querySelector("[data-animating]") !== null) return null;
    if (view.pending?.forYou === true && doc.querySelector(PROMPT) !== null) return "prompt";
    const endTurn = doc.querySelector<HTMLButtonElement>(ts(END_TURN));
    const board = doc.querySelector(ts(BOARD));
    if (view.pending === null && view.phase === "main" && board?.getAttribute("data-active") === "you" && endTurn !== null && !endTurn.disabled) {
      return "turn";
    }
    return null;
  };
  return cy
    .window({ timeout: timeouts.game, log: false })
    .should((win) => {
      expect(classify(win), "a showcase, the human's turn, a prompt or a result").to.not.eq(null);
    })
    .then((win) => classify(win) ?? "over");
}

/** Act once, then wait for the snapshot that answers it, so nothing is sent twice. */
function actOnce(act: () => void): void {
  cy.window({ log: false }).then((win) => {
    const before = practiceView(win);
    act();
    cy.window({ timeout: timeouts.game, log: false }).should((later) => {
      expect(practiceView(later), "the snapshot that answers the action").to.not.eq(before);
    });
  });
}

/** Answer whatever prompt the human holds: keep the whole hand for a mulligan, else the first option. */
function answerHumanPrompt(): void {
  actOnce(() => {
    cy.get(PROMPT)
      .first()
      .then(($prompt) => {
        const mulligan = $prompt.is(promptOf("mulligan"));
        cy.wrap($prompt).within(() => {
          if (mulligan) {
            cy.get(ANY_PROMPT_OPTION).each(($option) => {
              const marked = $option.closest("[aria-pressed], [data-selected]");
              const element = marked.length > 0 ? marked : $option;
              if (element.attr("aria-pressed") === "true" || element.attr("data-selected") === "true") return;
              cy.wrap($option, { log: false }).click();
            });
          } else {
            cy.get(ANY_PROMPT_OPTION).first().click();
          }
        });
      });
    cy.get("body").then(($body) => {
      const submit = $body.find(ts(PROMPT_SUBMIT));
      if (submit.length > 0 && !submit.is(":disabled")) cy.wrap(submit.first()).click();
    });
  });
}

/** Keep going until the AI has played a card the showcase held up and took down again. */
function untilTheAiPlays(turns = PRACTICE_TURN_BUDGET, prompts = PROMPT_BUDGET): void {
  waitForShowcaseOrHuman().then((waited) => {
    if (waited === "showcase") return;
    expect(waited, "the game is still on").to.not.eq("over");
    if (waited === "prompt") {
      expect(prompts, "the human's prompts run out").to.be.greaterThan(0);
      answerHumanPrompt();
      untilTheAiPlays(turns, prompts - 1);
      return;
    }
    expect(turns, "the AI played a card inside the turn budget").to.be.greaterThan(0);
    actOnce(() => {
      cy.get(ts(END_TURN)).click();
    });
    untilTheAiPlays(turns - 1, prompts);
  });
}

// ---------------------------------------------------------------------------------------------
// the spec
// ---------------------------------------------------------------------------------------------

describe("17 — the opponent's play held up, and the log and the piles looked into", () => {
  it("holds the opponent's played card up for about a second, click-through, and never the viewer's own", () => {
    cy.seedGame({ seed: SEED, a: DECK_A, b: DECK_B });
    const played: Played = { instanceId: "", defId: "", seat: "" };
    playOffered(UNIT_DEF_IDS, played);
    // The seat that played it holds the device: its own play is never held up.
    cy.get(ts(SHOWCASE)).should("not.exist");

    cy.window().then(installRecorder);
    // The seat ends its turn and hands the device over; the arriving seat catches up on the play.
    cy.endTurn();
    cy.then(() => {
      const name = nameOf(played.defId);
      cy.get(ts(SHOWCASE))
        .should("have.attr", "data-showcase", "played")
        .and("have.attr", "data-showcase-def", played.defId)
        .and("have.css", "pointer-events", "none");
      cy.get(ts(SHOWCASE_FACE)).should("contain.text", name);
      cy.get(ts(SHOWCASE_LIVE)).should("have.text", `Opponent played ${name}`);
      // It goes by itself, after about a second.
      cy.get(ts(SHOWCASE), { timeout: timeouts.animation }).should("not.exist");
      expectHeldAboutASecond(played.defId);
      cy.get(ts(SHOWCASE_LIVE)).should("have.text", "");
    });

    // The arriving seat plays a card of its own: nothing is held up for it.
    const own: Played = { instanceId: "", defId: "", seat: "" };
    playOffered(UNIT_DEF_IDS, own);
    cy.get(ts(SHOWCASE)).should("not.exist");
    recorder().then((recorded) => {
      expect(
        recorded.showcases.filter((entry) => entry.def === own.defId && own.defId !== played.defId),
        "the viewer's own play",
      ).to.have.length(0);
    });
  });

  it("R97 / R227 a trap the opponent sets face down is held up as a back that names nothing", () => {
    cy.seedGame({ seed: TRAP_SEED, a: TRAP_DECK_A, b: TRAP_DECK_B });
    // Player 1's first turn: nothing to show yet, so it passes to player 2.
    cy.gameState().then((state) => {
      ensureSeat(state.active);
      cy.endTurn();
    });
    ensureSeat("p2");
    cy.playByName(TRAP_NAME, { zone: { side: "you", row: "backrow", lane: 3 } });
    // Its controller set it: nothing is held up on this seat.
    cy.get(ts(SHOWCASE)).should("not.exist");

    cy.window().then(installRecorder);
    // R82 may already have ended player 2's turn (one mana, one card); either way hand the device on.
    cy.gameState().then((state) => {
      if (state.active === "p2") cy.endTurn();
      else cy.handOver();
    });
    cy.get(ts(SHOWCASE)).should("have.attr", "data-showcase", "set").and("not.have.attr", "data-showcase-def");
    cy.get(ts(SHOWCASE_BACK)).should("exist");
    cy.get(ts(SHOWCASE_FACE)).should("not.exist");
    cy.get(ts(SHOWCASE_CAPTION)).should("have.text", "Opponent set a card");
    cy.get(ts(SHOWCASE_LIVE)).should("have.text", "Opponent set a card");
    cy.get(ts(SHOWCASE)).should(($showcase) => {
      expect($showcase.text(), "the showcase never names the face-down card").to.not.contain(TRAP_NAME);
      expect($showcase.html(), "nor carries its id").to.not.match(/core-\d+/);
    });
    cy.get(ts(SHOWCASE), { timeout: timeouts.animation }).should("not.exist");
    recorder().then((recorded) => {
      const set = recorded.showcases.filter((entry) => entry.kind === "set");
      expect(set, "one face-down set held up").to.have.length(1);
      expect(set[0]?.def ?? null, "with no definition").to.eq(null);
      expect(set[0]?.text ?? "", "and no name").to.not.contain(TRAP_NAME);
    });
    // Nor does the log open it: the line about the set names no card.
    cy.get(ts(LOG)).should(($log) => {
      const opens = $log
        .find(ts(LOG_CARD))
        .toArray()
        .map((line) => `${line.textContent ?? ""} ${line.getAttribute("data-def-id") ?? ""}`);
      expect(opens.join("\n"), "no log line opens the face-down card").to.not.contain(TRAP_NAME);
      expect(opens.join("\n"), "nor names its definition").to.not.contain("core-041");
    });
  });

  it("a log line that names a card shows the card on hover, and in a sheet on a click", () => {
    cy.seedGame({ seed: SEED, a: DECK_A, b: DECK_B });
    const played: Played = { instanceId: "", defId: "", seat: "" };
    playOffered(UNIT_DEF_IDS, played);
    cy.endTurn();

    cy.then(() => {
      const name = nameOf(played.defId);
      const line = `${ts(LOG)} ${ts(LOG_CARD)}[data-def-id="${played.defId}"]`;
      cy.get(line).first().should("contain.text", name);

      // A resting mouse opens the card's face beside the log.
      cy.get(line).first().trigger("pointerover", { pointerType: "mouse" });
      cy.get(ts(INSPECT_HOVER)).should("be.visible").and("contain.text", name);
      cy.get(line).first().trigger("pointerout", { pointerType: "mouse" });
      cy.get(ts(INSPECT_HOVER)).should("not.exist");

      // A click (a tap, Enter) opens it in the sheet; Escape closes it.
      cy.get(line).first().click();
      cy.get(ts(INSPECT_SHEET)).should("be.visible").and("have.attr", "role", "dialog").and("contain.text", name);
      cy.get(ts(INSPECT_CLOSE)).should("have.focus");
      cy.get("body").type("{esc}");
      cy.get(ts(INSPECT_SHEET)).should("not.exist");
    });

    // A line about no particular card (a draw, a mana change) opens nothing.
    cy.get(`${ts(LOG)} .log-line[data-event="manaChanged"]`).first().find(ts(LOG_CARD)).should("not.exist");
  });

  it("a graveyard shows its cards, newest first, on hover and in a dialog on a click, on both seats", () => {
    cy.seedGame({ seed: SEED, a: DECK_A, b: DECK_B });
    const spell: Played = { instanceId: "", defId: "", seat: "" };
    playOffered(SPELL_DEF_IDS, spell);

    cy.then(() => {
      const name = nameOf(spell.defId);
      const pile = ts("graveyard-you");
      // The library is hidden, so it is a count and nothing else.
      cy.get(ts("library-you")).should("not.have.attr", "data-browsable");

      cy.get(ts(graveyardCountId("you")))
        .invoke("text")
        .then((text) => {
          const count = Number(text);
          expect(count, "the Spell resolved into its owner's graveyard").to.be.at.least(1);

          // Hover: the count and the newest faces, click-through.
          cy.get(`${pile}${BROWSABLE}`).trigger("pointerover", { pointerType: "mouse" });
          cy.get(ts(INSPECT_LIST_HOVER)).should("be.visible").and("have.css", "pointer-events", "none");
          cy.get(`${ts(INSPECT_LIST_HOVER)} ${ts(INSPECT_LIST_COUNT)}`).should("have.attr", "data-count", String(count));
          cy.get(`${ts(INSPECT_LIST_HOVER)} ${ts(INSPECT_LIST_CARD)}`).first().should("have.attr", "data-def-name", name);
          cy.get(pile).trigger("pointerout", { pointerType: "mouse" });
          cy.get(ts(INSPECT_LIST_HOVER)).should("not.exist");

          // Click: every card in a dialog, newest first; a face opens large, Back returns, Escape closes.
          cy.get(pile).click();
          cy.get(ts(INSPECT_LIST_SHEET)).should("be.visible").and("have.attr", "role", "dialog");
          cy.get(`${ts(INSPECT_LIST_SHEET)} ${ts(INSPECT_LIST_CARD)}`).should("have.length", count);
          cy.get(`${ts(INSPECT_LIST_SHEET)} ${ts(INSPECT_LIST_CARD)}`).first().should("have.attr", "data-def-name", name).click();
          cy.get(ts(INSPECT_LIST_DETAIL)).should("be.visible").and("contain.text", name);
          cy.get(ts(INSPECT_LIST_BACK)).click();
          cy.get(ts(INSPECT_LIST_DETAIL)).should("not.exist");
          cy.get(`${ts(INSPECT_LIST_SHEET)} ${ts(INSPECT_LIST_CARD)}`).should("have.length", count);
          cy.get("body").type("{esc}");
          cy.get(ts(INSPECT_LIST_SHEET)).should("not.exist");
          cy.get(pile).should("have.focus");

          // The other seat reads the same pile as the opponent's: public, so browsable there too.
          cy.endTurn();
          cy.get(`${ts("graveyard-opponent")}${BROWSABLE}`).click();
          cy.get(`${ts(INSPECT_LIST_SHEET)} ${ts(INSPECT_LIST_CARD)}`).first().should("have.attr", "data-def-name", name);
          cy.get(ts(INSPECT_CLOSE)).click();
          cy.get(ts(INSPECT_LIST_SHEET)).should("not.exist");
        });
    });
  });

  it("practice: the AI's played card is held up for about a second, and the AI waits for it", () => {
    cy.visit(practiceUrl(SEED), { onBeforeLoad: installRecorder });
    cy.get(promptOf("mulligan"), { timeout: BOOT_TIMEOUT }).should("be.visible");
    untilTheAiPlays();

    recorder().then((recorded) => {
      const shown = recorded.showcases.filter((entry) => entry.kind === "played" && entry.goneAt !== null);
      expect(shown.length, "the AI played a card the showcase held up").to.be.at.least(1);
      for (const entry of shown) {
        const held = (entry.goneAt ?? 0) - entry.shownAt;
        expect(held, `the AI's ${entry.def ?? "card"} stood for about a second`).to.be.within(HOLD_MIN_MS, HOLD_MAX_MS);
        expect(entry.pointerEvents, "the showcase is click-through").to.eq("none");
        // The AI's next step waits for it: its snapshot does not move while the card is up. The step
        // that played the card lands in the same commit that raises the showcase, hence the margin.
        const during = recorded.steps.filter((step) => step.at > entry.shownAt + 50 && step.at < (entry.goneAt ?? 0));
        expect(during, `no AI step while ${entry.def ?? "the card"} was held up`).to.have.length(0);
      }
    });
  });
});
