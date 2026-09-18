// The five commands BUILD's repo layout names — seedGame, playCard, attack, answerPrompt,
// endTurn — plus the waiting primitives that let the suite obey the M8 house rule: no fixed
// `cy.wait(ms)` anywhere. Every wait here is an assertion Cypress retries (a testid appearing, or
// `data-animating` clearing), never a sleep.
//
// All DOM knowledge lives in support/testids.ts. All URL and account knowledge lives in
// support/config.ts. A spec should not contain a raw selector.

import { CARD_NAMES, allCardIds, cardId as catalogId } from "./cards.ts";
import {
  SESSION_STORAGE_KEY,
  constants,
  hotseatUrl,
  server,
  timeouts,
  type E2EAccount,
} from "./config.ts";
import {
  ANIMATING,
  DECK_DRAG_MIME,
  END_TURN,
  OFFER_DRAW,
  POWER,
  PROMPT,
  PROMPT_SUBMIT,
  PROMPT_X_INPUT,
  RESULT_OVERLAY,
  SEAT_SWITCH,
  cardId,
  cardPoolId,
  deckDropId,
  deckTabId,
  handCardId,
  heroId,
  animating,
  promptOf,
  promptOptionId,
  switchPositionId,
  ts,
  zoneId,
} from "./testids.ts";
import type {
  ActionInput,
  EventType,
  FixtureDeck,
  GameStateLike,
  JackiOhDevHandle,
  PlayerId,
  PromptAnswer,
  PromptKind,
  Side,
  ZoneRef,
} from "./types.ts";

/** ASSUMPTION A1: where `seedGame` parks the fixture decks so a reload keeps them. */
export const DECKS_STORAGE_KEY = "jackioh.e2e.decks";

export type SeedGameOptions = {
  /** Every spec sets a seed (BUILD M8). */
  seed: string;
  /** Deck fixture ids, i.e. `e2e/fixtures/decks/<id>.json` without the extension. */
  a: string;
  b: string;
  /**
   * `keep` answers the opening mulligan prompts by keeping every card, which is what all but
   * spec 02 want. `manual` leaves them open for the spec to drive.
   */
  mulligan?: "keep" | "manual";
};

export type PromptStep = PromptAnswer & { kind?: PromptKind };

/**
 * Every acting command ends by draining `data-animating` (`cy.settled()`), which is what keeps the
 * suite free of fixed waits — but it also closes the window BUILD M5-T4 asks three specs to look
 * through ("glow animation", "AI actions animate", `rotated` / `swapped`). `expectAnimating` is
 * that window, asserted by the command itself, between the click and the drain: acting and
 * capturing in one step, so a spec never has to hand-roll the clicks to get in between them.
 *
 *     cy.playByName("Knockoff Temu", { expectAnimating: "radiantSet" });
 *     cy.attack(attacker, { hero: "opponent" }, { expectAnimating: ["attackCancelled"] });
 */
export type ActOptions = {
  expectAnimating?: EventType | EventType[];
};

export type PlayCardOptions = ActOptions & {
  /** R81: the zone travels in the play action; the client builds it from a board click. */
  zone?: ZoneRef;
  /** R81: further play-time pickers (targets, modes, X, embiggen, tribute), in the order shown. */
  answers?: PromptStep[];
};

export type AttackTarget = { card: string } | { hero: Side };

/**
 * Mirrors `WsPlayerCommand` in support/tasks/wsPlayer.ts, which is the file that actually speaks
 * the protocol. Anything the task accepts must be declarable here or a spec cannot ask for it.
 *
 * There is no `joinRoom`: `apps/server/src/match/protocol.ts` accepts that frame only to answer it
 * with `error { code: "unsupported" }`. Joining a room is `POST /api/rooms/:code/join` — the
 * atomic single-claim and the loadout re-check are HTTP concerns, and a socket is only ever opened
 * onto a match that already exists.
 */
export type WsPlayerCommand =
  | {
      action: "connect";
      name: string;
      url?: string;
      token?: string;
      matchId?: string;
      roomCode?: string;
      /** The seat this client holds. Defaults to `p2`, which is the seat a joiner gets (§9.5). */
      seat?: PlayerId;
    }
  | { action: "send"; name: string; body: ActionInput }
  | { action: "awaitView"; name: string; where?: ViewPredicate }
  | { action: "view"; name: string }
  | { action: "messages"; name: string }
  | { action: "disconnect"; name: string }
  | { action: "reset" };

/** What `awaitView` waits for. Every field is `AND`ed; an omitted one is not looked at. */
export type ViewPredicate = {
  active?: PlayerId;
  phase?: string;
  /** Only ever satisfied by a prompt THIS client holds: §10.6 hides the kind from the other seat. */
  promptKind?: string;
  hasResult?: boolean;
  /** `view.turn >= n`. §10.1's turn counter is 1-based and counts player-turns (R2). */
  turnAtLeast?: number;
};

export type WsPlayerResult = {
  ok: boolean;
  name?: string;
  seat?: string;
  view?: Record<string, unknown> | null;
  messages?: { type: string; [key: string]: unknown }[];
  /** §9.3: the server's reason, relayed verbatim — `ErrorMessage.message`, never a restatement. */
  error?: string;
  /** `ErrorMessage.code`: `illegal_action`, `rate_limited`, `match_over`, `forbidden`, … */
  code?: string;
  /** `AckMessage.seq`: the append-only log seq an accepted action was written at (§9.3). */
  seq?: number;
};

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

function asDeck(raw: unknown, id: string): FixtureDeck {
  const deck = raw as Partial<FixtureDeck>;
  expect(deck, `fixture decks/${id}.json`).to.be.an("object");
  expect(deck.cards, `decks/${id}.json cards`).to.be.an("array");
  const cards = deck.cards ?? [];
  // L2/L3 (SPEC §9.4) are enforced by `validateDeck` in the engine, which throws inside
  // `createGame`. Failing here instead gives a readable message before the app is even loaded.
  expect(cards.length, `decks/${id}.json holds DECK_SIZE cards`).to.eq(constants.DECK_SIZE);
  expect(new Set(cards).size, `decks/${id}.json has no duplicate ids (L3)`).to.eq(cards.length);
  const known = new Set(Object.keys(CARD_NAMES).map((index) => catalogId(Number(index))));
  for (const card of cards) {
    expect(known.has(card), `decks/${id}.json: "${card}" is a SPEC §8 catalog id (L6)`).to.eq(true);
  }
  return { id, spec: deck.spec ?? id, description: deck.description ?? "", cards };
}

function exists(selector: string): Cypress.Chainable<boolean> {
  return cy.get("body").then(($body) => $body.find(selector).length > 0);
}

function clickZone(zone: ZoneRef): void {
  cy.get(ts(zoneId(zone.side, zone.row, zone.lane))).click();
}

/** A pick is offered either as a prompt option or as the board card itself (BUILD M5-T2). */
function clickPick(...selectors: string[]): void {
  cy.get("body").then(($body) => {
    const found = selectors.find((selector) => $body.find(selector).length > 0);
    expect(found, `one of ${selectors.join(" | ")} is present`).to.not.eq(undefined);
    cy.get(found ?? selectors[0] ?? "body").click();
  });
}

/** Any `prompt-option-<key>`, so a picker can be answered without naming a key. */
const ANY_PROMPT_OPTION = `[data-testid^="${promptOptionId("")}"]`;

/**
 * Whether a toggle is already chosen. A4: the client marks a picked option with `aria-pressed`
 * (`apps/web/src/game/Prompt.tsx`); `data-selected` is the board's spelling of the same thing
 * (`Board.test.tsx`). Either counts, and the attribute may sit on the clickable ancestor when the
 * testid is on an inner label.
 */
function isPicked($option: JQuery<HTMLElement>): boolean {
  const marked = $option.closest('[aria-pressed], [data-selected]');
  const element = marked.length > 0 ? marked : $option;
  return element.attr("aria-pressed") === "true" || element.attr("data-selected") === "true";
}

/** BUILD M5-T4: assert the animation this command just caused, before it is drained. */
function captureAnimating(expected: EventType | EventType[] | undefined): void {
  if (expected === undefined) return;
  for (const event of Array.isArray(expected) ? expected : [expected]) {
    cy.expectAnimating(event);
  }
}

// ---------------------------------------------------------------------------------------------
// waiting: BUILD M8 forbids fixed waits, so everything below is a retried assertion
// ---------------------------------------------------------------------------------------------

Cypress.Commands.add("settled", () => {
  cy.get(ANIMATING, { timeout: timeouts.animation, log: false }).should("not.exist");
});

Cypress.Commands.add("expectAnimating", (event: EventType) => {
  cy.get(animating(event), { timeout: timeouts.animation }).should("exist");
});

Cypress.Commands.add("waitForPrompt", (kind: PromptKind) => {
  cy.get(promptOf(kind), { timeout: timeouts.view }).should("be.visible");
});

Cypress.Commands.add("noPrompt", () => {
  cy.get(PROMPT, { timeout: timeouts.animation }).should("not.exist");
});

// ---------------------------------------------------------------------------------------------
// the dev handle (BUILD M5-T3)
// ---------------------------------------------------------------------------------------------

Cypress.Commands.add("jackioh", () => {
  return cy
    .window({ timeout: timeouts.view, log: false })
    .should((win) => {
      expect(win.__jackioh, "window.__jackioh (BUILD M5-T3)").to.not.eq(undefined);
    })
    .then((win) => win.__jackioh as JackiOhDevHandle);
});

Cypress.Commands.add("gameState", () => {
  return cy.jackioh().then((handle) => handle.state);
});

/**
 * Setup shortcut only: `reduce` refuses illegal actions itself (SPEC §9.3), so dispatching is
 * never a way past the rules — but it is a way past the UI, so specs use it to reach a
 * pre-condition, never to exercise the behaviour under test.
 */
Cypress.Commands.add("dispatchAction", (action: ActionInput) => {
  cy.jackioh().then((handle) => {
    handle.dispatch(action);
  });
  cy.settled();
});

// ---------------------------------------------------------------------------------------------
// finding cards: by name through the DOM, or by defId/zone through the dev handle
// ---------------------------------------------------------------------------------------------

/** The instance id in `hand-card-<instanceId>` / `card-<instanceId>`. */
function instanceIdOf($element: JQuery<HTMLElement>): string {
  const testid = $element.attr("data-testid") ?? "";
  const id = testid.replace(/^hand-card-/, "").replace(/^card-/, "");
  expect(id, `an instance id inside "${testid}"`).to.not.eq("");
  return id;
}

/** The instance id of the named card in the shown hand (BUILD M5-T1: hand cards show the name). */
Cypress.Commands.add("handCardByName", (name: string) => {
  return cy
    .get('[data-testid^="hand-card-"]', { timeout: timeouts.view })
    .contains(name)
    .closest('[data-testid^="hand-card-"]')
    .then(($card) => instanceIdOf($card));
});

/** The instance id of the named card on the field, either side. */
Cypress.Commands.add("fieldCardByName", (name: string) => {
  return cy
    .get('[data-testid^="card-"]', { timeout: timeouts.view })
    .contains(name)
    .closest('[data-testid^="card-"]')
    .then(($card) => instanceIdOf($card));
});

/**
 * The instance id of the first `defId` in a player's hand, read off the dev handle. Use it only
 * where the DOM cannot answer (the other seat's hand, or a card whose name is not rendered).
 */
Cypress.Commands.add("instanceInHand", (player: PlayerId, defId: string) => {
  return cy.gameState().then((state) => {
    const side = state.players[player] as { hand?: { id: string; defId: string }[] };
    const found = (side.hand ?? []).find((card) => card.defId === defId);
    expect(found, `${defId} in ${player}'s hand`).to.not.eq(undefined);
    return found?.id ?? "";
  });
});

/** The instance id occupying a zone: the top card of a Stack pile for units (SPEC §3.2). */
Cypress.Commands.add("instanceAt", (player: PlayerId, row: "units" | "backrow", lane: number) => {
  return cy.gameState().then((state) => {
    const side = state.players[player] as {
      units?: ({ id: string }[] | null)[];
      backrow?: ({ id: string } | null)[];
    };
    const slot =
      row === "units" ? (side.units ?? [])[lane - 1]?.[0] ?? null : (side.backrow ?? [])[lane - 1] ?? null;
    expect(slot, `a card at ${player} ${row} lane ${lane}`).to.not.eq(null);
    return slot?.id ?? "";
  });
});

/** Play the named hand card. The readable form of `handCardByName` + `playCard`. */
Cypress.Commands.add("playByName", (name: string, options: PlayCardOptions = {}) => {
  cy.handCardByName(name).then((instanceId) => {
    cy.playCard(instanceId, options);
  });
});

// ---------------------------------------------------------------------------------------------
// seedGame
// ---------------------------------------------------------------------------------------------

Cypress.Commands.add("seedGame", (options: SeedGameOptions) => {
  const { seed, a, b, mulligan = "keep" } = options;

  cy.fixture(`decks/${a}.json`).then((rawA) => {
    cy.fixture(`decks/${b}.json`).then((rawB) => {
      const decks = {
        [a]: asDeck(rawA, a).cards,
        [b]: asDeck(rawB, b).cards,
      };
      cy.visit(hotseatUrl(seed, a, b), {
        onBeforeLoad(win) {
          // ASSUMPTION A1: in E2E mode the hotseat route resolves `a=`/`b=` from this injection
          // before falling back to its built-in dev decks.
          win.__jackiohE2E = { seed, decks };
          try {
            win.localStorage.setItem(DECKS_STORAGE_KEY, JSON.stringify({ seed, decks }));
          } catch (error) {
            Cypress.log({ name: "seedGame", message: `localStorage unavailable: ${String(error)}` });
          }
        },
      });
    });
  });

  cy.jackioh().should((handle) => {
    expect(handle.seed, "seed reached the engine").to.eq(seed);
  });
  cy.settled();
  if (mulligan === "keep") cy.keepMulligans();
});

/**
 * R9 / §2.1: the opening mulligan, answered by keeping the whole opening hand.
 *
 * THE ANSWER NAMES THE CARDS KEPT, NOT THE CARDS RETURNED. The engine's prompt is "Choose the
 * cards to keep; the rest are returned and redrawn" with `min: 0` and one option per hand card
 * (`packages/engine/src/setup.ts`), and `answerMulligan` returns every card *not* in `keep`. So
 * keeping everything means selecting every option and then confirming: submitting with nothing
 * toggled sends `keep: []`, which mulligans the entire hand — the opposite of this command's name,
 * and a silent change to the opening hand of every spec that seeds a game.
 */
Cypress.Commands.add("keepMulligans", () => {
  const drain = (remaining: number): void => {
    if (remaining === 0) return;
    exists(promptOf("mulligan")).then((open) => {
      if (!open) return;
      cy.get(promptOf("mulligan")).within(() => {
        // The mulligan is per-card toggles plus a confirm, whatever its max (BUILD M5-T2).
        cy.get(ANY_PROMPT_OPTION).each(($option) => {
          if (isPicked($option)) return;
          cy.wrap($option, { log: false }).click();
        });
        cy.get(ts(PROMPT_SUBMIT)).click();
      });
      cy.settled();
      drain(remaining - 1);
    });
  };
  // At most one mulligan per seat (SPEC §2.1).
  drain(2);
});

// ---------------------------------------------------------------------------------------------
// playCard / attack / answerPrompt / endTurn
// ---------------------------------------------------------------------------------------------

Cypress.Commands.add("playCard", (instanceId: string, options: PlayCardOptions = {}) => {
  cy.get(ts(handCardId(instanceId)), { timeout: timeouts.view }).click();
  if (options.zone !== undefined) clickZone(options.zone);
  for (const step of options.answers ?? []) {
    cy.answerPrompt(step.kind ?? null, step);
  }
  captureAnimating(options.expectAnimating);
  cy.settled();
});

Cypress.Commands.add("attack", (attackerId: string, target: AttackTarget, options: ActOptions = {}) => {
  cy.get(ts(cardId(attackerId)), { timeout: timeouts.view }).click();
  if ("hero" in target) {
    cy.get(ts(heroId(target.hero))).click();
  } else {
    cy.get(ts(cardId(target.card))).click();
  }
  captureAnimating(options.expectAnimating);
  cy.settled();
});

Cypress.Commands.add("answerPrompt", (kind: PromptKind | null, answer: PromptAnswer = {}) => {
  const root = kind === null ? PROMPT : promptOf(kind);
  cy.get(root, { timeout: timeouts.view }).should("be.visible");

  // §10.6: a Discover's three options are drawn by the match rng, so a spec cannot name a key —
  // it can only say "the first". Taken in DOM order, which is `PendingChoice.options` order and
  // therefore the same on every machine (packages/engine/src/prompts.ts).
  if (answer.first !== undefined) {
    const wanted = answer.first;
    cy.get(root)
      .find(ANY_PROMPT_OPTION)
      .should("have.length.at.least", wanted)
      .then(($options) => {
        for (let at = 0; at < wanted; at += 1) {
          cy.wrap($options.eq(at), { log: false }).click();
        }
      });
  }
  // R81's embiggen price: the picker's two options are the two prices, keyed by the boolean.
  if (answer.embiggen !== undefined) {
    const key = String(answer.embiggen);
    clickPick(`${PROMPT} ${ts(promptOptionId(key))}`, ts(promptOptionId(key)));
  }
  for (const key of answer.options ?? []) {
    clickPick(`${PROMPT} ${ts(promptOptionId(key))}`, ts(promptOptionId(key)));
  }
  for (const instanceId of answer.cards ?? []) {
    clickPick(
      `${PROMPT} ${ts(promptOptionId(instanceId))}`,
      `${PROMPT} ${ts(cardId(instanceId))}`,
      ts(cardId(instanceId)),
      ts(handCardId(instanceId)),
    );
  }
  for (const zone of answer.zones ?? []) {
    clickZone(zone);
  }
  if (answer.hero !== undefined) {
    cy.get(ts(heroId(answer.hero))).click();
  }
  if (answer.x !== undefined) {
    cy.get(root).within(() => {
      cy.get(ts(PROMPT_X_INPUT)).clear();
      cy.get(ts(PROMPT_X_INPUT)).type(String(answer.x));
    });
  }

  const picks =
    (answer.options?.length ?? 0) +
    (answer.cards?.length ?? 0) +
    (answer.zones?.length ?? 0) +
    (answer.first ?? 0) +
    (answer.embiggen === undefined ? 0 : 1);
  const needsSubmit = answer.submit ?? (picks > 1 || answer.x !== undefined);
  if (needsSubmit) {
    cy.get(root).within(() => {
      cy.get(ts(PROMPT_SUBMIT)).click();
    });
  }
  cy.settled();
});

Cypress.Commands.add("endTurn", (options: ActOptions & { handOver?: boolean } = {}) => {
  cy.get(ts(END_TURN), { timeout: timeouts.view }).should("not.be.disabled");
  cy.get(ts(END_TURN)).click();
  captureAnimating(options.expectAnimating);
  cy.settled();
  if (options.handOver ?? true) cy.handOver();
});

/** BUILD M5-T3: the hotseat seat-switch button. A no-op when the client switches by itself. */
Cypress.Commands.add("handOver", () => {
  exists(ts(SEAT_SWITCH)).then((present) => {
    if (!present) return;
    cy.get(ts(SEAT_SWITCH)).click();
    cy.settled();
  });
});

Cypress.Commands.add("switchPosition", (instanceId: string, options: ActOptions = {}) => {
  cy.get(ts(switchPositionId(instanceId))).click();
  captureAnimating(options.expectAnimating);
  cy.settled();
});

Cypress.Commands.add("offerDraw", () => {
  cy.get(ts(OFFER_DRAW)).click();
  cy.settled();
});

Cypress.Commands.add("usePower", (options: ActOptions = {}) => {
  cy.get(ts(POWER)).click();
  captureAnimating(options.expectAnimating);
  cy.settled();
});

// ---------------------------------------------------------------------------------------------
// Reading a seat's piles, and getting to a turn
// ---------------------------------------------------------------------------------------------

type SidePeek = {
  hand?: { id: string; defId: string }[];
  units?: ({ id: string }[] | null)[];
};

function peek(state: GameStateLike, player: PlayerId): SidePeek {
  return state.players[player] as SidePeek;
}

/**
 * The instance ids in a seat's hand, read off `window.__jackioh.state`.
 *
 * CLAUDE.md rule 7: this answers exactly one question — "which instance ids might I click?" — and
 * never what the game says happened. Every assertion belongs on the DOM, which is `viewFor`. Use
 * it where the DOM cannot answer: the other seat's hand, or a card whose name is not rendered.
 */
Cypress.Commands.add("handIds", (player: PlayerId) => {
  return cy.gameState().then((state) => (peek(state, player).hand ?? []).map((card) => card.id));
});

/**
 * The top card of each of a seat's unit zones, in lane order, skipping empty lanes. §3.2: only a
 * Stack pile's top card is the active one, so that is the only id worth clicking.
 */
Cypress.Commands.add("unitIds", (player: PlayerId) => {
  return cy.gameState().then((state) =>
    (peek(state, player).units ?? []).flatMap((pile) => {
      const top = pile === null ? undefined : pile[0];
      return top === undefined ? [] : [top.id];
    }),
  );
});

/**
 * End turns until `turn` is the current player-turn (§10.1: 1-based, player 1 takes the odd ones).
 *
 * R82-SAFE. "A turn ends by itself when the active player's only legal actions are ending the
 * turn, conceding and offering a draw" — so the turn under a spec's feet may already have moved on
 * and there may be no `end-turn` left to press, only a device to hand over (BUILD M5-T3). This
 * therefore re-reads the state every step, hands the device to whoever is active, and only presses
 * `end-turn` when the client is still offering it.
 */
Cypress.Commands.add("advanceToTurn", (turn: number, options: { budget?: number } = {}) => {
  const budget = options.budget ?? turn * 2 + 4;
  const step = (remaining: number): void => {
    cy.gameState().then((state) => {
      expect(state.turn, `player-turn ${String(turn)} has not already gone by`).to.be.at.most(turn);
      if (state.turn >= turn) return;
      expect(remaining, `player-turn ${String(turn)} is reachable inside the budget`).to.be.greaterThan(0);
      cy.jackioh().then((handle) => {
        // In hotseat the handle names the seat holding the device; networked, there is nothing to
        // hand over and `seat` is this client's own seat for the whole match.
        if (handle.seat !== undefined && handle.seat !== state.active) cy.handOver();
      });
      exists(ts(END_TURN)).then((present) => {
        if (present) cy.endTurn();
        else cy.handOver();
      });
      step(remaining - 1);
    });
  };
  step(budget);
});

// ---------------------------------------------------------------------------------------------
// Sessions (A10): the networked specs sign in before they visit
// ---------------------------------------------------------------------------------------------

/**
 * The account `cy.signIn` last named, for the rest of this spec file. `testIsolation: true` clears
 * the browser's copy between tests, so a remembered account is re-installed on every load rather
 * than assumed to still be there — which is what makes `cy.signIn` usable from a `before` hook.
 */
let signedIn: E2EAccount | null = null;

/** A10: the shape `apps/web/src/net/session.ts` parses — an access token and nothing else. */
function writeSession(win: Window, account: E2EAccount): void {
  try {
    win.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ accessToken: account.token }));
  } catch (error) {
    Cypress.log({ name: "signIn", message: `localStorage unavailable: ${String(error)}` });
  }
}

/**
 * Sign in as a fixture account.
 *
 * STORAGE, NOT IN-PAGE STATE: spec 05 reloads mid-match and the session has to survive it, so it
 * is `localStorage[SESSION_STORAGE_KEY]`, written in `onBeforeLoad` so the very first boot already
 * has it (the client reads the session while it decides which screen to render, §9.4's gate).
 *
 * It composes with a visit two ways, and both install the session before the page's own scripts
 * run: `cy.visitAs(account, path)`, or `cy.signIn(account)` followed by any later `cy.visit` —
 * `visit` is overwritten below to carry whatever session was last signed in.
 */
Cypress.Commands.add("signIn", (account: E2EAccount) => {
  signedIn = account;
  return cy.wrap(account, { log: false });
});

/** Forget the session, so a later `cy.visit` boots signed out (§9.4's login screen). */
Cypress.Commands.add("signOut", () => {
  signedIn = null;
  cy.window({ log: false }).then((win) => {
    try {
      win.localStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // A private window or blocked site data: there was no session to remove.
    }
  });
});

/** `cy.signIn(account)` + `cy.visit(path)`, which is how the networked specs open a screen. */
Cypress.Commands.add("visitAs", (account: E2EAccount, path: string, options: Partial<Cypress.VisitOptions> = {}) => {
  cy.signIn(account);
  cy.visit(path, options);
});

// A signed-in session is installed by the visit itself, chained onto whatever `onBeforeLoad` the
// caller passed (so `seedGame`'s deck injection still runs). With no session signed in this is a
// pass-through and every hotseat spec behaves exactly as before.
const carrySession = (originalFn: (...args: unknown[]) => unknown, ...args: unknown[]): unknown => {
  const account = signedIn;
  if (account === null) return originalFn(...args);
  const [first, second] = args;
  const given = (typeof first === "string" ? second : first) as Partial<Cypress.VisitOptions> | undefined;
  const merged: Partial<Cypress.VisitOptions> = {
    ...(given ?? {}),
    onBeforeLoad(win: Cypress.AUTWindow) {
      writeSession(win, account);
      given?.onBeforeLoad?.(win);
    },
  };
  return typeof first === "string" ? originalFn(first, merged) : originalFn(merged);
};

// `as never` only silences the overload gymnastics of Commands.overwrite, exactly as the fixed-wait
// guard in support/e2e.ts does; the function itself is fully typed above.
Cypress.Commands.overwrite("visit", carrySession as never);

// ---------------------------------------------------------------------------------------------
// Loadouts (A12) and the deckbuilder (A11)
// ---------------------------------------------------------------------------------------------

function api(path: string): string {
  return `${server.http()}${path}`;
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/**
 * A12: one scenario deck, padded into the loadout §9.4 will accept.
 *
 * L1 wants exactly `DECKS_PER_LOADOUT` decks and L4 wants no card in two of them, so a one-deck
 * scenario fixture cannot be saved on its own. The padding is the next `DECK_SIZE * 2` Core ids
 * the fixture did not use, which keeps all three decks disjoint and — with R111's one copy of
 * every non-token card — inside L5.
 */
export function loadoutFrom(deck: readonly string[], deckIndex = 0): string[][] {
  const used = new Set(deck);
  const spare = allCardIds().filter((id) => !used.has(id));
  const size = constants.DECK_SIZE;
  expect(spare.length, "enough spare Core ids to pad a loadout").to.be.at.least(size * 2);
  const padding = [spare.slice(0, size), spare.slice(size, size * 2)];
  const decks: string[][] = [];
  for (let at = 0; at < constants.DECKS_PER_LOADOUT; at += 1) {
    decks.push(at === deckIndex ? [...deck] : (padding.shift() ?? []));
  }
  return decks;
}

/**
 * Install a fixture deck as one of an account's three decks. §9.4: `saveLoadout` is the only
 * authority, and it "writes all three decks in one transaction or nothing", so the whole loadout
 * goes in one PUT — against the `catalogVersion` the server is serving right now, because a stale
 * one gets "update required" rather than a save.
 *
 * `deckIndex` defaults to 0, which is the deck a room or a queue ticket freezes (§9.5).
 */
Cypress.Commands.add(
  "installLoadout",
  (account: E2EAccount, fixtureId: string, options: { deckIndex?: number } = {}) => {
    const deckIndex = options.deckIndex ?? 0;
    expect(deckIndex, `a deck index inside L1's ${String(constants.DECKS_PER_LOADOUT)} decks`).to.be.within(
      0,
      constants.DECKS_PER_LOADOUT - 1,
    );
    cy.fixture(`decks/${fixtureId}.json`).then((raw) => {
      const decks = loadoutFrom(asDeck(raw, fixtureId).cards, deckIndex);
      cy.request<{ catalogVersion: string }>({
        method: "GET",
        url: api("/api/loadout"),
        headers: bearer(account.token),
      }).then((current) => {
        cy.request({
          method: "PUT",
          url: api("/api/loadout"),
          headers: bearer(account.token),
          body: { catalogVersion: current.body.catalogVersion, decks },
        })
          .its("status")
          .should("eq", 200);
      });
    });
  },
);

/**
 * A11: drag a card from the pool into a deck, in the deckbuilder.
 *
 * BUILD M8 spec 09's row is "a card dragged into a second deck is refused", and a drag is a
 * multi-event gesture — `dragstart` on the source with a `DataTransfer`, `dragover` and `drop` on
 * the target, `dragend` to let go — that no spec should hand-roll. The `DataTransfer` is built in
 * the app's own window so the events carry the object the page can read.
 *
 * `deckIndex` is 0-based, like `installLoadout`'s and like `POST /api/rooms`'s; the testids are
 * 1-based because that is what the screen shows ("Deck 1", §9.4's `deckLabel`).
 */
Cypress.Commands.add("dragCardToDeck", (catalogCardId: string, deckIndex: number) => {
  expect(deckIndex, `a deck index inside L1's ${String(constants.DECKS_PER_LOADOUT)} decks`).to.be.within(
    0,
    constants.DECKS_PER_LOADOUT - 1,
  );
  const oneBased = deckIndex + 1;
  const source = ts(cardPoolId(catalogCardId));
  const targets = [ts(deckDropId(oneBased)), ts(deckTabId(oneBased))];

  cy.get(source, { timeout: timeouts.view }).should("exist");
  // A builder that drops straight onto a tab needs no click first, so selecting the deck is
  // best-effort rather than required.
  exists(ts(deckTabId(oneBased))).then((tabbed) => {
    if (tabbed) cy.get(ts(deckTabId(oneBased))).click();
  });

  cy.window({ log: false }).then((win) => {
    const dataTransfer = new win.DataTransfer();
    dataTransfer.setData(DECK_DRAG_MIME, catalogCardId);
    dataTransfer.setData("text/plain", catalogCardId);

    cy.get(source).trigger("dragstart", { dataTransfer, eventConstructor: "DragEvent" });
    cy.get("body").then(($body) => {
      const found = targets.find((selector) => $body.find(selector).length > 0);
      expect(found, `a drop target for deck ${String(oneBased)}: ${targets.join(" | ")}`).to.not.eq(
        undefined,
      );
      const target = found ?? targets[0] ?? "body";
      cy.get(target).trigger("dragover", { dataTransfer, eventConstructor: "DragEvent" });
      cy.get(target).trigger("drop", { dataTransfer, eventConstructor: "DragEvent" });
    });
    // The source may be gone or greyed out after a successful drop, so letting go is best-effort.
    exists(source).then((present) => {
      if (present) cy.get(source).trigger("dragend", { dataTransfer, eventConstructor: "DragEvent" });
    });
  });
  cy.settled();
});

// ---------------------------------------------------------------------------------------------
// replay determinism (spec 01) and the Node WebSocket player (spec 06)
// ---------------------------------------------------------------------------------------------

/**
 * BUILD M8 spec 01: "final state hash equals the vitest replay of the recorded actions".
 * The browser hands over (seed, decks, log, final state); `cy.task("replayHash")` folds the log
 * through `packages/engine/src/replay.ts` in Node — the same code path the vitest replay uses —
 * and hashes both states with `hashState`.
 */
Cypress.Commands.add("replayCheck", (label: string) => {
  cy.jackioh().then((handle) => {
    const { seed, decks, log, state } = handle;
    expect(decks, "window.__jackioh.decks (ASSUMPTION A2)").to.be.an("array");
    expect(log, "window.__jackioh.log (ASSUMPTION A2)").to.be.an("array");
    return cy
      .task<{ replayHash: string; browserHash: string; errors: unknown[] }>(
        "replayHash",
        { label, seed, decks, log, state },
        { timeout: timeouts.task },
      )
      .should((result) => {
        expect(result.errors, "the recorded log replays with no rejected action").to.deep.eq([]);
        expect(result.replayHash, "engine replay hash equals the browser's final state hash").to.eq(
          result.browserHash,
        );
      });
  });
});

Cypress.Commands.add("wsPlayer", (command: WsPlayerCommand) => {
  return cy.task<WsPlayerResult>("wsPlayer", command, { timeout: timeouts.task }).should((result) => {
    expect(result.ok, `wsPlayer ${command.action}: ${result.error ?? "ok"}`).to.eq(true);
  });
});

Cypress.Commands.add("expectResult", (text: "Win" | "Loss" | "Draw") => {
  cy.get(ts(RESULT_OVERLAY), { timeout: timeouts.game }).should("be.visible");
  cy.get(ts(RESULT_OVERLAY)).should("contain.text", text);
});

// ---------------------------------------------------------------------------------------------

// Augmenting Cypress's own `Chainable` means using its namespace and repeating its
// `Subject = any` default exactly, or declaration merging fails.
/* eslint-disable @typescript-eslint/no-namespace, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
declare global {
  namespace Cypress {
    interface Chainable<Subject = any> {
      /** Visit the hotseat route with a seed and two fixture decks (BUILD M5-T3). */
      seedGame(options: SeedGameOptions): Chainable<void>;
      /** Keep every card in any open opening-mulligan prompt (R9). */
      keepMulligans(): Chainable<void>;
      /** Play a hand card, building its R81 play-time choices from the UI. */
      playCard(instanceId: string, options?: PlayCardOptions): Chainable<void>;
      /** Declare an attack against a unit or a hero (SPEC §4.2). */
      attack(attackerId: string, target: AttackTarget): Chainable<void>;
      /** Answer the open prompt; `null` accepts whatever kind is open (SPEC §10.6). */
      answerPrompt(kind: PromptKind | null, answer?: PromptAnswer): Chainable<void>;
      /** Click `end-turn`, then hand the device over if the client asks for it. */
      endTurn(options?: { handOver?: boolean }): Chainable<void>;
      handOver(): Chainable<void>;
      switchPosition(instanceId: string): Chainable<void>;
      offerDraw(): Chainable<void>;
      usePower(): Chainable<void>;
      /** Every `data-animating` element has drained (BUILD M5-T4). */
      settled(): Chainable<void>;
      /** An element is currently animating this event type. */
      expectAnimating(event: EventType): Chainable<void>;
      waitForPrompt(kind: PromptKind): Chainable<void>;
      noPrompt(): Chainable<void>;
      /** The instance id of the named card in the shown hand. */
      handCardByName(name: string): Chainable<string>;
      /** The instance id of the named card on the field. */
      fieldCardByName(name: string): Chainable<string>;
      instanceInHand(player: PlayerId, defId: string): Chainable<string>;
      instanceAt(player: PlayerId, row: "units" | "backrow", lane: number): Chainable<string>;
      playByName(name: string, options?: PlayCardOptions): Chainable<void>;
      jackioh(): Chainable<JackiOhDevHandle>;
      gameState(): Chainable<GameStateLike>;
      dispatchAction(action: ActionInput): Chainable<void>;
      replayCheck(label: string): Chainable<void>;
      wsPlayer(command: WsPlayerCommand): Chainable<WsPlayerResult>;
      expectResult(text: "Win" | "Loss" | "Draw"): Chainable<void>;
    }
  }
}
