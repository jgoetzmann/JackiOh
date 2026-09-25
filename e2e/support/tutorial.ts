// The tutorial (SPEC §9.10) as specs 22 and 23 drive it: the lesson URL, progress seeded before the
// page boots, the dev handles `/practice` exposes in a non-production build, and a driver that
// follows the coach through the real UI.
//
// THE DRIVER NEVER DISPATCHES. `window.__jackiohTutorial.suggested` names what the coach's showing
// step asks for (the first of the human's legal actions its `expect` accepts, tutorial/devHandle.ts)
// and the driver performs it with clicks, as a player following the coach would: a mulligan through
// the picker's toggles and Confirm, a play as a hand click and then the zone or target the action
// names, an attack as the attacker and then its target, End turn as End turn. The engine accepts or
// refuses each exactly as in any game. `__jackiohPractice.view` is read only to know that the page
// has received the snapshot an action produced, and to find where a card sits on the board.
//
// Every wait is an assertion Cypress retries (BUILD M8): `waitForMoment` waits for the board to
// settle, the coach to catch up with it and either a bubble to read or a move for the human.

import { timeouts, TUTORIAL_PROGRESS_KEY } from "./config.ts";
import {
  ACTION_ERROR,
  ANIMATING,
  BOARD,
  COACH,
  COACH_ACK,
  END_TURN,
  POWER,
  PROMPT,
  PROMPT_SUBMIT,
  TUTORIAL_HUD,
  TUTORIAL_RESULT,
  TUTORIAL_STEP,
  cardId,
  handCardId,
  heroId,
  promptOf,
  promptOptionId,
  switchPositionId,
  ts,
  zoneId,
} from "./testids.ts";
import type { Action, ActionBody, Lane, PlayerId, Row, Selection, Side } from "./types.ts";

// ---------------------------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------------------------

/** The practice route the lesson path and every lesson live on. */
export const PRACTICE_PATH = "/practice";

/** The module worker loads the engine, the card scripts and the AI before its first answer. */
export const TUTORIAL_BOOT_TIMEOUT = 60_000;

/**
 * How long the driver waits for the human's next moment. It can span a whole AI turn: the AI takes
 * one step each time the board has caught up with the last one, and a coach tip may hold it.
 */
export const MOMENT_TIMEOUT = 90_000;

/** How long an action may take to come back from the worker as a new snapshot. */
export const SNAPSHOT_TIMEOUT = 20_000;

/** A play needs at most one pick per R81 choice kind (X, embiggen, Tribute, targets, modes, zone), plus slack. */
const PLAY_PICK_BUDGET = 10;

// ---------------------------------------------------------------------------------------------
// the handles (routes/practice.tsx and tutorial/devHandle.ts, dev builds only)
// ---------------------------------------------------------------------------------------------

/** Structural subsets of the `@jackioh/shared` view types (packages/shared/src/view.ts). */
export type CardLike = { instanceId: string; defId: string };
export type PendingOptionLike = {
  key: string;
  label?: string;
  instanceId?: string;
  defId?: string;
  player?: PlayerId;
  row?: Row;
  lane?: number;
};
export type PendingLike =
  | { forYou: true; choiceId: string; kind: string; options: PendingOptionLike[]; min: number; max: number }
  | { forYou: false; pendingFor: PlayerId };
export type SideLike = {
  player: PlayerId;
  hero: { health: number };
  hand: CardLike[] | { count: number };
  units: (CardLike | null)[];
};
export type PlayerViewLike = {
  viewer: PlayerId;
  turn: number;
  active: PlayerId;
  phase: string;
  you: SideLike;
  opponent: SideLike;
  pending: PendingLike | null;
  events: unknown[];
  result: { winner: PlayerId | "draw"; reason: string } | null;
};

/** `PracticeDebug` (apps/web/src/practice/protocol.ts). */
export type PracticeDebugLike = {
  seed: string;
  decks: [string[], string[]];
  handicaps: Partial<Record<PlayerId, Record<string, number>>>;
  log: Action[];
  state: unknown;
  hash: string;
  difficulty: string;
  humanSeat: PlayerId;
  lesson?: string;
};

export type PracticeHandleLike = {
  snapshot(): Promise<PracticeDebugLike>;
  readonly aiSeat: PlayerId | null;
  readonly thinking: boolean;
  readonly view: PlayerViewLike | null;
};

/** `CoachDisplay` (apps/web/src/tutorial/coach.ts), as far as the specs read it. */
export type CoachDisplayLike = {
  mode: "finished" | "waiting" | "tip" | "step";
  id?: string;
  ack?: boolean;
  stepNumber?: number;
  stepCount?: number;
};

export type TutorialHandleLike = {
  readonly lessonId: string;
  readonly display: CoachDisplayLike;
  readonly suggested: ActionBody | null;
};

type TutorialWindow = { __jackiohPractice?: PracticeHandleLike; __jackiohTutorial?: TutorialHandleLike };

function handlesOf(win: Window): TutorialWindow {
  return win as unknown as TutorialWindow;
}

export function practiceHandle(): Cypress.Chainable<PracticeHandleLike> {
  return cy
    .window({ timeout: TUTORIAL_BOOT_TIMEOUT, log: false })
    .should((win) => {
      expect(handlesOf(win).__jackiohPractice, "window.__jackiohPractice (dev builds)").to.not.eq(undefined);
      expect(handlesOf(win).__jackiohPractice?.view, "the practice game's first snapshot").to.not.eq(null);
    })
    .then((win) => handlesOf(win).__jackiohPractice as PracticeHandleLike);
}

export function tutorialHandle(): Cypress.Chainable<TutorialHandleLike> {
  return cy
    .window({ timeout: TUTORIAL_BOOT_TIMEOUT, log: false })
    .should((win) => {
      expect(handlesOf(win).__jackiohTutorial, "window.__jackiohTutorial (dev builds, in a lesson)").to.not.eq(undefined);
    })
    .then((win) => handlesOf(win).__jackiohTutorial as TutorialHandleLike);
}

/** The newest snapshot's view, as the page holds it; null before the first. */
export function currentView(win: Window): PlayerViewLike | null {
  return handlesOf(win).__jackiohPractice?.view ?? null;
}

/** The debug record of the game on screen: seed, decks, handicaps, log, state and hash. */
export function debugSnapshot(): Cypress.Chainable<PracticeDebugLike> {
  return practiceHandle().then((handle) => cy.wrap(handle.snapshot(), { log: false, timeout: timeouts.task }));
}

export function handOf(view: PlayerViewLike): CardLike[] {
  return Array.isArray(view.you.hand) ? view.you.hand : [];
}

// ---------------------------------------------------------------------------------------------
// visiting, progress and motion
// ---------------------------------------------------------------------------------------------

/** `/practice?lesson=<id>&pace=fast`: the lesson starts at once on its own seed and seat. */
export function lessonUrl(lessonId: string): string {
  const params = new URLSearchParams({ lesson: lessonId, pace: "fast" });
  return `${PRACTICE_PATH}?${params.toString()}`;
}

export type TutorialVisit = {
  /**
   * What `localStorage[TUTORIAL_PROGRESS_KEY]` holds as the page boots: absent or null removes it
   * (no progress), a string is written verbatim (so a corrupt value can be seeded), anything else
   * is written as JSON.
   */
  progress?: unknown;
  /** `prefers-reduced-motion: reduce`, as spec 13's Hard game uses it. */
  reducedMotion?: boolean;
  /** More setup, run after the above and before the page's own scripts. */
  onBeforeLoad?: (win: Cypress.AUTWindow) => void;
};

export function writeProgress(win: Window, progress: unknown): void {
  try {
    if (progress === undefined || progress === null) win.localStorage.removeItem(TUTORIAL_PROGRESS_KEY);
    else win.localStorage.setItem(TUTORIAL_PROGRESS_KEY, typeof progress === "string" ? progress : JSON.stringify(progress));
  } catch (error) {
    Cypress.log({ name: "tutorial", message: `localStorage unavailable: ${String(error)}` });
  }
}

/** `prefers-reduced-motion: reduce`: the board draws every view as it arrives (BUILD M5-T4). */
export function preferReducedMotion(win: Cypress.AUTWindow): void {
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

export function visitTutorial(path: string, options: TutorialVisit = {}): void {
  cy.visit(path, {
    onBeforeLoad(win) {
      writeProgress(win, options.progress);
      if (options.reducedMotion === true) preferReducedMotion(win);
      options.onBeforeLoad?.(win);
    },
  });
}

/** What the page has stored, parsed; null when nothing is. */
export function storedProgress(): Cypress.Chainable<unknown> {
  return cy.window({ log: false }).then((win) => {
    const raw = win.localStorage.getItem(TUTORIAL_PROGRESS_KEY);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  });
}

// ---------------------------------------------------------------------------------------------
// the coach and the HUD, as the DOM shows them
// ---------------------------------------------------------------------------------------------

export type StepCounter = { step: number; of: number };

/**
 * The HUD's "Step k of n", or null when it is not shown (the lesson is over). The counter carries a
 * long form and a short one ("k/n") side by side, one of them hidden by the layout, so the text of
 * the whole element runs them together ("Step 1 of 181/18"): each element inside it is read on its
 * own, the long form first.
 */
export function stepCounterIn(doc: Document): StepCounter | null {
  const root = doc.querySelector(ts(TUTORIAL_STEP));
  if (root === null) return null;
  const texts = [root, ...Array.from(root.querySelectorAll("*"))].map((element) => (element.textContent ?? "").trim());
  for (const pattern of [/^Step\s+(\d+)\s+of\s+(\d+)$/, /^(\d+)\s*\/\s*(\d+)$/]) {
    for (const text of texts) {
      const match = pattern.exec(text);
      if (match !== null) return { step: Number(match[1]), of: Number(match[2]) };
    }
  }
  return null;
}

export function stepCounter(): Cypress.Chainable<StepCounter> {
  let found: StepCounter | null = null;
  return cy
    .document({ log: false })
    .should((doc) => {
      found = stepCounterIn(doc);
      expect(found, `"Step k of n" in ${TUTORIAL_STEP}`).to.not.eq(null);
    })
    .then(() => found as StepCounter);
}

/** What the coach bubble shows: its mode and step (or tip) id, or null when there is no bubble. */
export type CoachMark = { mode: string; step: string | null };

export function coachMarkIn(doc: Document): CoachMark | null {
  const coach = doc.querySelector(ts(COACH));
  if (coach === null) return null;
  return { mode: coach.getAttribute("data-coach-mode") ?? "", step: coach.getAttribute("data-coach-step") };
}

function sameMark(a: CoachMark | null, b: CoachMark | null): boolean {
  return a === null || b === null ? a === b : a.mode === b.mode && a.step === b.step;
}

// ---------------------------------------------------------------------------------------------
// moments: when the human has something to do
// ---------------------------------------------------------------------------------------------

export type Moment =
  /** The lesson is over and its result dialog is up. */
  | { kind: "over"; outcome: string | null }
  /** The coach shows "Got it" (a tip or an info step). */
  | { kind: "ack"; coach: CoachMark | null; counter: StepCounter | null }
  /** A prompt the human must answer is open. */
  | { kind: "prompt"; promptKind: string; coach: CoachMark | null; counter: StepCounter | null; suggested: ActionBody | null }
  /** The human's own main phase, nothing open. */
  | { kind: "turn"; coach: CoachMark | null; counter: StepCounter | null; suggested: ActionBody | null };

/** Why there is no moment yet, for the timeout message. */
type Waiting = { waiting: string };

function momentIn(win: Window): Moment | Waiting {
  const doc = win.document;
  const result = doc.querySelector(ts(TUTORIAL_RESULT));
  if (result !== null) return { kind: "over", outcome: result.getAttribute("data-outcome") };
  const busy = doc.querySelector(ANIMATING);
  if (busy !== null) return { waiting: `the board is animating ${busy.getAttribute("data-animating") ?? ""}` };
  const coach = doc.querySelector(ts(COACH));
  if (coach?.getAttribute("data-stale") === "true") return { waiting: "the coach has not caught up with the board" };
  const tutorial = handlesOf(win).__jackiohTutorial;
  if (tutorial === undefined) return { waiting: "window.__jackiohTutorial is not set" };
  const mark = coachMarkIn(doc);
  const counter = stepCounterIn(doc);
  if (doc.querySelector(ts(COACH_ACK)) !== null) return { kind: "ack", coach: mark, counter };

  const hud = doc.querySelector(ts(TUTORIAL_HUD));
  if (hud?.getAttribute("data-thinking") !== "false") return { waiting: "the AI owes an action" };
  const prompt = doc.querySelector(PROMPT);
  if (prompt !== null) {
    return {
      kind: "prompt",
      promptKind: prompt.getAttribute("data-prompt-kind") ?? "",
      coach: mark,
      counter,
      suggested: tutorial.suggested,
    };
  }
  const board = doc.querySelector(ts(BOARD));
  const endTurn = doc.querySelector<HTMLButtonElement>(ts(END_TURN));
  const mine = board?.getAttribute("data-active") === "you" && board.getAttribute("data-phase") === "main";
  if (mine && endTurn !== null && !endTurn.disabled) {
    return { kind: "turn", coach: mark, counter, suggested: tutorial.suggested };
  }
  return { waiting: "neither the human's turn nor a prompt for the human" };
}

/**
 * Wait for the next moment the human acts in: the board settled, the coach caught up with it, and
 * then a bubble to read, a prompt to answer, the human's own main phase, or the lesson's end.
 */
export function waitForMoment(timeout = MOMENT_TIMEOUT): Cypress.Chainable<Moment> {
  let found: Moment | Waiting = { waiting: "not looked yet" };
  return cy
    .window({ timeout, log: false })
    .should((win) => {
      found = momentIn(win);
      expect("kind" in found ? "" : found.waiting, "waiting for the human's next moment").to.eq("");
    })
    .then(() => found as Moment);
}

// ---------------------------------------------------------------------------------------------
// acting through the UI
// ---------------------------------------------------------------------------------------------

/** Any `prompt-option-<key>`. */
const ANY_PROMPT_OPTION = `[data-testid^="${promptOptionId("")}"]`;

function optionKey($option: JQuery<HTMLElement>): string {
  return ($option.attr("data-testid") ?? "").slice(promptOptionId("").length);
}

/** A4: a chosen option is `aria-pressed="true"` (or `data-selected`), on it or an ancestor. */
function isPicked($option: JQuery<HTMLElement>): boolean {
  const marked = $option.closest("[aria-pressed], [data-selected]");
  const element = marked.length > 0 ? marked : $option;
  return element.attr("aria-pressed") === "true" || element.attr("data-selected") === "true";
}

/** `selectionKey` (apps/web/src/game/actions.ts): how a play picker keys a declared target. */
function selectionKey(selection: Selection): string {
  switch (selection.pick) {
    case "instance":
      return `instance:${selection.instanceId}`;
    case "hero":
      return `hero:${selection.player}`;
    case "zone":
      return `zone:${selection.player}:${selection.row}:${String(selection.lane)}`;
    case "mode":
      return `mode:${selection.option}`;
    case "none":
      return "none";
  }
}

function sideOf(view: PlayerViewLike, player: PlayerId): Side {
  return player === view.viewer ? "you" : "opponent";
}

/** Where a declared target sits on the board (`selectionTestid`), or null for a mode or "none". */
function boardTestidOf(view: PlayerViewLike, selection: Selection): string | null {
  switch (selection.pick) {
    case "instance":
      return handOf(view).some((card) => card.instanceId === selection.instanceId)
        ? handCardId(selection.instanceId)
        : cardId(selection.instanceId);
    case "hero":
      return heroId(sideOf(view, selection.player));
    case "zone":
      return zoneId(sideOf(view, selection.player), selection.row, selection.lane as Lane);
    case "mode":
    case "none":
      return null;
  }
}

/** The testid an attack's `targetId` names: `hero-<player>` is a hero, anything else a unit. */
function attackTargetTestid(view: PlayerViewLike, targetId: string): string {
  for (const side of [view.you, view.opponent]) {
    if (targetId === `hero-${side.player}`) return heroId(sideOf(view, side.player));
  }
  return cardId(targetId);
}

/** The engine prompt option an `answer` selection names (`selectionForOption`, read backwards). */
function optionFor(options: readonly PendingOptionLike[], selection: Selection): PendingOptionLike | undefined {
  return options.find((option) => {
    switch (selection.pick) {
      case "zone":
        return option.row === selection.row && option.lane === selection.lane && option.player === selection.player;
      case "instance":
        return option.instanceId === selection.instanceId && option.row === undefined;
      case "hero":
        return option.player === selection.player && option.instanceId === undefined && option.row === undefined;
      case "mode":
        return option.defId === selection.option || option.key === selection.option || option.key.endsWith(`:${selection.option}`);
      case "none":
        return option.key === "none" || option.key.startsWith("none:");
    }
  });
}

/**
 * A player can click this element: its centre is not under something else (the coach's bubble, a
 * picker). A zone or a target is clicked on the board when it is; otherwise it is picked in the
 * play picker, which lists every zone and target the play may take and is the other way a player
 * makes the same choice.
 */
function reachable(element: Element): boolean {
  const box = element.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return false;
  const hit = element.ownerDocument.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  return hit !== null && (hit === element || element.contains(hit));
}

/** Confirm a picker that is still open after its picks (a multi-select, or the mulligan). */
function submitIfStillOpen(root: string): void {
  cy.get("body", { log: false }).then(($body) => {
    const submit = $body.find(`${root} ${ts(PROMPT_SUBMIT)}`);
    if (submit.length > 0 && submit.attr("aria-disabled") !== "true") cy.wrap(submit.first(), { log: false }).click();
  });
}

/** R9 through the picker: toggle every card so exactly `keep` is kept, check it, then Confirm. */
export function mulliganThroughUi(keep: readonly string[]): void {
  const wanted = [...keep].sort();
  cy.get(promptOf("mulligan"), { timeout: TUTORIAL_BOOT_TIMEOUT }).should("be.visible");
  cy.get(promptOf("mulligan")).within(() => {
    cy.get(ANY_PROMPT_OPTION).each(($option) => {
      if (isPicked($option) !== keep.includes(optionKey($option))) cy.wrap($option, { log: false }).click();
    });
    cy.get(ANY_PROMPT_OPTION).should(($options) => {
      const kept = $options
        .toArray()
        .map((element) => Cypress.$(element))
        .filter(($option) => isPicked($option))
        .map(($option) => optionKey($option))
        .sort();
      expect(kept, "the cards marked Keep are exactly the ones the coach keeps").to.deep.eq(wanted);
    });
    cy.get(ts(PROMPT_SUBMIT)).click();
  });
}

/** Answer an engine prompt with the options an `answer` action names, then Confirm if it waits. */
function answerThroughUi(action: Extract<ActionBody, { type: "answer" }>): void {
  cy.window({ log: false }).then((win) => {
    const pending = currentView(win)?.pending ?? null;
    expect(pending !== null && pending.forYou, "a prompt for the human is open").to.eq(true);
    const options = pending !== null && pending.forYou ? pending.options : [];
    for (const selection of action.selection) {
      const option = optionFor(options, selection);
      expect(option, `a prompt option for ${JSON.stringify(selection)}`).to.not.eq(undefined);
      cy.get(`${PROMPT} ${ts(promptOptionId(option?.key ?? ""))}`).click();
    }
    submitIfStillOpen(PROMPT);
  });
}

/** Answer whatever prompt is open with its first option (the harness's autopilot), confirming if it waits. */
export function answerFirstOption(): void {
  cy.get("body", { log: false }).then(($body) => {
    if ($body.find(promptOf("mulligan")).length > 0) {
      // The autopilot keeps the whole hand: every card marked Keep, then Confirm.
      cy.get(promptOf("mulligan")).within(() => {
        cy.get(ANY_PROMPT_OPTION).each(($option) => {
          if (!isPicked($option)) cy.wrap($option, { log: false }).click();
        });
        cy.get(ts(PROMPT_SUBMIT)).click();
      });
      return;
    }
    cy.get(PROMPT).first().find(ANY_PROMPT_OPTION).first().click();
    submitIfStillOpen(PROMPT);
  });
}

type PlayAction = Extract<ActionBody, { type: "play" }>;

/**
 * The picks a play still owes after its hand card was clicked (R81), made one at a time in the
 * order the client asks for them: whatever the play picker shows next, answered with the value the
 * action carries — a zone or a declared target clicked on the board where it can be, else in the
 * picker. Done once the hand card is no longer selected: the client has sent the play.
 */
function finishPlay(play: PlayAction, view: PlayerViewLike, remaining: number): void {
  cy.get("body", { log: false }).then(($body) => {
    const card = $body.find(ts(handCardId(play.instanceId)));
    if (card.length === 0 || card.attr("data-selected") !== "true") return;
    expect(remaining, `the play of ${play.instanceId} is complete within ${String(PLAY_PICK_BUDGET)} picks`).to.be.greaterThan(0);

    const picker = $body.find(`${PROMPT}[data-prompt-source="play"]`);
    const kind = picker.attr("data-prompt-kind");
    const inPicker = (key: string): string => `${PROMPT}[data-prompt-source="play"] ${ts(promptOptionId(key))}`;
    const onBoard = (testid: string): boolean => {
      const element = $body.find(`${ts(testid)}[data-legal="true"]`)[0];
      return element !== undefined && reachable(element);
    };

    switch (kind) {
      case "zone": {
        const zone = play.zone;
        expect(zone, "the play names its zone").to.not.eq(undefined);
        if (zone === undefined) return;
        const where = zoneId("you", zone.row, zone.lane as Lane);
        cy.get(onBoard(where) ? ts(where) : inPicker(`${zone.row}:${String(zone.lane)}`)).click();
        break;
      }
      case "x":
        cy.get(inPicker(String(play.x))).click();
        break;
      case "embiggen":
        cy.get(inPicker(String(play.embiggen))).click();
        break;
      case "tribute":
        for (const id of play.tributes ?? []) cy.get(inPicker(id)).click();
        submitIfStillOpen(`${PROMPT}[data-prompt-source="play"]`);
        break;
      case "target":
      case "hand": {
        // One target at a time, on the board where it is drawn and clickable; the picker otherwise.
        const next = (play.targets ?? []).find((selection) => {
          const where = boardTestidOf(view, selection);
          return where === null || $body.find(`${ts(where)}[data-selected="true"]`).length === 0;
        });
        expect(next, "the play names a target still to pick").to.not.eq(undefined);
        if (next === undefined) return;
        const where = boardTestidOf(view, next);
        if (where !== null && onBoard(where)) cy.get(ts(where)).click();
        else {
          cy.get(inPicker(selectionKey(next))).click();
          submitIfStillOpen(`${PROMPT}[data-prompt-source="play"]`);
        }
        break;
      }
      case "mode":
      case "direction":
        for (const mode of play.modes ?? []) cy.get(inPicker(mode)).click();
        submitIfStillOpen(`${PROMPT}[data-prompt-source="play"]`);
        break;
      default:
        // No picker drawn yet: read the board again.
        break;
    }
    finishPlay(play, view, remaining - 1);
  });
}

export type PerformHooks = {
  /** Called after a play's hand card is picked up and before its zone or target is chosen. */
  afterPickUp?: (play: PlayAction) => void;
};

/**
 * Perform one action through the UI. Nothing is dispatched: every action is the clicks a player
 * makes, and an action the spec cannot make with clicks fails the spec rather than being sent.
 */
export function performThroughUi(action: ActionBody, hooks: PerformHooks = {}): void {
  cy.window({ log: false }).then((win) => {
    const view = currentView(win);
    expect(view, "the page holds a view").to.not.eq(null);
    if (view === null) return;
    switch (action.type) {
      case "mulligan":
        mulliganThroughUi(action.keep);
        return;
      case "play":
        cy.get(ts(handCardId(action.instanceId))).should("have.attr", "data-legal", "true").click();
        hooks.afterPickUp?.(action);
        finishPlay(action, view, PLAY_PICK_BUDGET);
        return;
      case "attack":
        cy.get(ts(cardId(action.attackerId))).should("have.attr", "data-legal", "true").click();
        cy.get(ts(attackTargetTestid(view, action.targetId))).should("have.attr", "data-legal", "true").click();
        return;
      case "endTurn":
        cy.get(ts(END_TURN)).should("not.be.disabled").click();
        return;
      case "switchPosition":
        cy.get(ts(switchPositionId(action.instanceId))).should("not.be.disabled").click();
        return;
      case "activatePower":
        expect(action.targets ?? [], "a power the coach asks for names no target (the spec clicks `power` alone)").to.deep.eq([]);
        cy.get(ts(POWER)).should("have.attr", "data-legal", "true").click();
        return;
      case "answer":
        answerThroughUi(action);
        return;
      default:
        throw new Error(`the coach suggested ${JSON.stringify(action)}, which no lesson step asks a player to do`);
    }
  });
}

/**
 * When the coach asks for nothing on the human's turn: attack the enemy hero with the first unit
 * that glows ready and may hit it, else end the turn. (An attacker that may not reach the hero,
 * behind a Taunt, is put back down.)
 */
export function fallbackTurn(): void {
  cy.get("body", { log: false }).then(($body) => {
    const attackers = $body
      .find(`[data-testid^="zone-you-units-"] [data-testid^="${cardId("")}"][data-glow="ready"]`)
      .toArray()
      .map((element) => element.getAttribute("data-testid") ?? "")
      .filter((testid) => testid !== "");
    const first = attackers[0];
    if (first === undefined) {
      cy.get(ts(END_TURN)).should("not.be.disabled").click();
      return;
    }
    cy.get(ts(first)).click();
    cy.get(ts(heroId("opponent"))).then(($hero) => {
      if ($hero.attr("data-legal") === "true") {
        cy.wrap($hero, { log: false }).click();
        return;
      }
      cy.get(ts(first)).click();
      cy.get(ts(END_TURN)).should("not.be.disabled").click();
    });
  });
}

// ---------------------------------------------------------------------------------------------
// one step of the driver
// ---------------------------------------------------------------------------------------------

export type Taken = "ack" | "coach" | "fallback";

/**
 * Take one moment: "Got it" on a bubble that shows it; the coach's suggested action through the
 * UI; or, when the coach asks for nothing, the fallback. Then wait for proof that it landed — the
 * bubble moved on after "Got it", a new snapshot after an action — and for no refusal.
 */
export function takeMoment(moment: Exclude<Moment, { kind: "over" }>, hooks: PerformHooks = {}): Cypress.Chainable<Taken> {
  if (moment.kind === "ack") {
    const before = moment.coach;
    cy.get(ts(COACH_ACK)).click();
    cy.document({ log: false, timeout: MOMENT_TIMEOUT }).should((doc) => {
      expect(sameMark(coachMarkIn(doc), before), `the coach moved on from ${JSON.stringify(before)}`).to.eq(false);
    });
    return cy.wrap<Taken>("ack", { log: false });
  }

  let before: PlayerViewLike | null = null;
  cy.window({ log: false }).then((win) => {
    before = currentView(win);
  });
  const suggested = moment.suggested;
  if (suggested !== null) performThroughUi(suggested, hooks);
  else if (moment.kind === "prompt") answerFirstOption();
  else fallbackTurn();
  cy.window({ log: false, timeout: SNAPSHOT_TIMEOUT }).should((win) => {
    expect(currentView(win) !== before, "the action came back from the worker as a new snapshot").to.eq(true);
  });
  cy.get(ts(ACTION_ERROR)).should("not.exist");
  return cy.wrap<Taken>(suggested === null ? "fallback" : "coach", { log: false });
}
