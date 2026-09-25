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
  CONCEDE,
  CONCEDE_CONFIRM,
  CONCEDE_DIALOG,
  DECK_DRAG_MIME,
  DECK_DROP,
  END_TURN,
  OFFER_DRAW,
  POWER,
  PROMPT,
  PROMPT_SUBMIT,
  PROMPT_X_INPUT,
  RESULT_OVERLAY,
  SEAT_SWITCH,
  cardId,
  handCardId,
  heroId,
  animating,
  poolCardId,
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

/** `cy.saveDeck`'s input: `PUT /api/decks/:id`'s body, and the id (minted when omitted). */
export type SaveDeckInput = {
  id?: string;
  name: string;
  cards: readonly string[];
  /** The catalog version to save against; read from `GET /api/decks` when omitted. */
  catalogVersion?: string;
};

/** `cy.saveTrio`'s input: `PUT /api/trios/:id`'s body, and the id (minted when omitted). */
export type SaveTrioInput = { id?: string; name: string; deckIds: (string | null)[] };

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
  /** Connect as `token`, concede `matchId` and close, in one task (see `cy.concedeAs`). */
  | { action: "concede"; name: string; url?: string; token: string; matchId: string; seat?: PlayerId }
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
  /**
   * R265, R266: `view.mulligan.opponentReady` — whether the OTHER seat has answered its mulligan.
   * Only a view inside the mulligan window carries `mulligan`, so no view outside it matches.
   */
  mulliganOpponentReady?: boolean;
  /** R269: `view.drawOffer.by` — the seat whose draw offer stands — or `null` for none. */
  drawOfferBy?: PlayerId | null;
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
 * R9 / §2.1: the opening mulligans, answered by keeping the whole opening hand.
 *
 * BOTH SEATS MULLIGAN AT ONCE (R265). Both prompts open with the deal, either seat may answer first,
 * and an answer is sealed until the other is in (R266). On `/dev/hotseat` the device follows the
 * seat that still owes one (`hotseat.ts`), so after the first Ready the second seat's picker is the
 * one on screen and this answers it too. Networked, this client only ever holds its own seat: after
 * its Ready the picker gives way to `mulligan-waiting` (no `data-prompt-kind`), so the loop ends
 * there, and the other seat answers from wherever it is driven (the `wsPlayer` task in 05, 06, 20).
 *
 * THE ANSWER NAMES THE CARDS KEPT, NOT THE CARDS RETURNED. The engine's prompt is "Choose the
 * cards to keep; the rest are returned and redrawn" with `min: 0` and one option per hand card
 * (`packages/engine/src/setup.ts`), and `answerMulligan` returns every card *not* in `keep`. So
 * keeping everything means every option selected when Confirm is pressed: submitting with nothing
 * toggled sends `keep: []`, which mulligans the entire hand — the opposite of this command's name,
 * and a silent change to the opening hand of every spec that seeds a game. The picker opens with
 * every card kept (Prompt.tsx), so this normally clicks Confirm alone; it still selects any card
 * that is not, so it holds whatever the picker's default.
 */
Cypress.Commands.add("keepMulligans", () => {
  // WAIT FOR THE CLIENT TO HAVE A VIEW BEFORE ASKING WHETHER A PICKER IS OPEN.
  //
  // `exists()` is one non-retrying DOM read, which is right for "is the SECOND seat's mulligan up?"
  // — by then the answer is already settled — and wrong for the first. A networked board has no
  // view at all for the first few frames after `cy.visit`: §9.5 has the actor push a fresh full
  // view on attach, and until that frame lands there is no prompt in the DOM to find. Asking then
  // answers "no", and this command returns having silently done nothing: seat 1 never mulligans,
  // the game never starts, and the spec fails much later somewhere else. (Measured, back when the
  // mulligans were answered in turn: spec 05 died in `wsPlayer` with "timed out waiting for a view
  // matching {promptKind: mulligan}", and spec 06 only escaped because twenty board assertions ran
  // first.)
  //
  // `window.__jackioh.state` is the client's own answer to "have I got a view yet": the hotseat
  // handle's is a getter over the live session and is never null, so this is a no-op there, while
  // `net.ts`'s is null until the first `view` frame arrives. Waiting on it costs the hotseat specs
  // nothing and closes the race for the networked ones in one place.
  cy.window({ timeout: timeouts.view, log: false }).should((win) => {
    const handle = win.__jackioh;
    expect(handle, "window.__jackioh (BUILD M5-T3)").to.not.eq(undefined);
    expect(
      handle?.state,
      "the client has a view to render (§9.5: the actor pushes one on attach)",
    ).to.not.eq(null);
  });

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

/**
 * §2.5: concede, through the confirmation the `concede` control opens ("Concede this game?"). The
 * control only asks; `concede-confirm` is what sends `{ type: "concede" }` (ConfirmConcede.tsx), so
 * a spec that clicks `concede` alone has conceded nothing.
 */
Cypress.Commands.add("concede", () => {
  cy.get(ts(CONCEDE), { timeout: timeouts.view }).should("not.be.disabled").click();
  cy.get(ts(CONCEDE_DIALOG)).should("be.visible");
  cy.get(ts(CONCEDE_CONFIRM)).click();
  cy.get(ts(CONCEDE_DIALOG)).should("not.exist");
  cy.settled();
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
// Saved decks and trios (A12) and the deck workshop (A11)
// ---------------------------------------------------------------------------------------------

function api(path: string): string {
  return `${server.http()}${path}`;
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/**
 * A12: one scenario deck, padded into a trio R253's Best of 3 will accept.
 *
 * L1 wants exactly `DECKS_PER_LOADOUT` decks and L4 wants no card in two of them, so a one-deck
 * scenario fixture cannot make a trio on its own. The padding is the next `DECK_SIZE * 2` Core ids
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

/** `GET /api/decks` (`DecksResponse` in apps/web/src/net/api.ts), as far as the suite reads it. */
export type SavedDecksBody = {
  catalogVersion: string;
  decks: { id: string; name: string; cards: string[]; catalogVersion: string; createdAt: number; updatedAt: number }[];
  trios: { id: string; name: string; deckIds: (string | null)[]; createdAt: number; updatedAt: number }[];
  limits: { decks: number; trios: number; nameLength: number };
};

/** What `cy.installLoadout` saved: three decks, oldest first, and the trio that holds them. */
export type InstalledLoadout = {
  /**
   * The three deck ids in saved order, which is `GET /api/decks` order (oldest first, ties on id)
   * and therefore R257's legacy order: `deckIds[n]` is the deck a `{ deckIndex: n }` body names.
   */
  deckIds: [string, string, string];
  /** The trio ("E2E trio") holding `deckIds` in slot order. */
  trioId: string;
  /** The cards of each deck, in the same order; `decks[deckIndex]` is the fixture's. */
  decks: string[][];
  /** The catalog version the decks were saved against. */
  catalogVersion: string;
};

/** The deck names `cy.installLoadout` saves, in order. */
export const INSTALLED_DECK_NAMES = ["Deck 1", "Deck 2", "Deck 3"] as const;
/** The trio name `cy.installLoadout` saves. */
export const INSTALLED_TRIO_NAME = "E2E trio";

/**
 * R256: a deck or trio id, minted by the client exactly as the workshop mints one. The fallback is
 * a version-4 UUID built by hand, for a runner whose spec frame is not a secure context.
 */
export function mintId(): string {
  const webCrypto = globalThis.crypto as Crypto | undefined;
  if (webCrypto !== undefined && typeof webCrypto.randomUUID === "function") return webCrypto.randomUUID();
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16));
  hex[12] = 4;
  hex[16] = ((hex[16] ?? 0) & 0x3) | 0x8;
  const text = hex.map((digit) => digit.toString(16)).join("");
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

/**
 * `count` fresh ids in ascending order. `GET /api/decks` lists oldest first and breaks a
 * `createdAt` tie on the id (`memory-stores.ts`, and Postgres orders a `uuid` the way its lower-case
 * text sorts), and three saves in a row can land in one millisecond — so decks saved in the order
 * of these ids list in that order whatever the clock did.
 */
export function mintIds(count: number): string[] {
  return Array.from({ length: count }, mintId)
    .map((id) => id.toLowerCase())
    .sort();
}

Cypress.Commands.add("savedDecks", (account: E2EAccount) => {
  return cy
    .request<SavedDecksBody>({ method: "GET", url: api("/api/decks"), headers: bearer(account.token) })
    .then((response) => {
      expect(response.status, "GET /api/decks").to.eq(200);
      return response.body;
    });
});

/**
 * Delete every trio and every deck an account has saved, and yield the catalog version the server
 * is serving (a save needs it: a stale one is 409 `update_required`, R253). Trios go first only for
 * tidiness: deleting a deck empties the slots that named it anyway (R252).
 */
Cypress.Commands.add("clearDecks", (account: E2EAccount) => {
  return cy.savedDecks(account).then((saved) => {
    for (const trio of saved.trios) {
      cy.request({ method: "DELETE", url: api(`/api/trios/${trio.id}`), headers: bearer(account.token) })
        .its("status")
        .should("eq", 200);
    }
    for (const deck of saved.decks) {
      cy.request({ method: "DELETE", url: api(`/api/decks/${deck.id}`), headers: bearer(account.token) })
        .its("status")
        .should("eq", 200);
    }
    return cy.wrap(saved.catalogVersion, { log: false });
  });
});

/** One `PUT /api/decks/:id` (R250, R256): a create for a new id, else a replace. Yields the id. */
Cypress.Commands.add("saveDeck", (account: E2EAccount, deck: SaveDeckInput) => {
  const id = deck.id ?? mintId();
  const put = (catalogVersion: string): Cypress.Chainable<string> =>
    cy
      .request({
        method: "PUT",
        url: api(`/api/decks/${id}`),
        headers: bearer(account.token),
        body: { name: deck.name, cards: deck.cards, catalogVersion },
      })
      .then((response) => {
        expect(response.status, `PUT /api/decks/${id} ("${deck.name}")`).to.eq(200);
        return id;
      });
  if (deck.catalogVersion !== undefined) return put(deck.catalogVersion);
  return cy.savedDecks(account).then((saved) => put(saved.catalogVersion));
});

/** One `PUT /api/trios/:id` (R252, R256). Yields the id. */
Cypress.Commands.add("saveTrio", (account: E2EAccount, trio: SaveTrioInput) => {
  const id = trio.id ?? mintId();
  return cy
    .request({
      method: "PUT",
      url: api(`/api/trios/${id}`),
      headers: bearer(account.token),
      body: { name: trio.name, deckIds: trio.deckIds },
    })
    .then((response) => {
      expect(response.status, `PUT /api/trios/${id} ("${trio.name}")`).to.eq(200);
      return id;
    });
});

/**
 * Install a fixture deck as saved deck `deckIndex` of an account, beside two padding decks, and a
 * trio of the three (SPEC §9.4, R250–R253).
 *
 * Everything the account had saved is deleted first, so the account holds exactly these three
 * decks ("Deck 1".."Deck 3", oldest first) and this one trio ("E2E trio", slot order), and a legacy
 * `{ deckIndex: n }` body (R257) names `deckIds[n]`. The decks go in one at a time, in the order of
 * ascending ids (`mintIds`), so their saved order is fixed whatever the clock does.
 *
 * `deckIndex` defaults to 0, which is the deck a legacy room or queue body with `deckIndex: 0`
 * freezes (§9.5). Yields the ids, so a spec can queue `{ mode: "bo1", deckId }` or
 * `{ mode: "bo3", trioId }` with them.
 */
Cypress.Commands.add(
  "installLoadout",
  (account: E2EAccount, fixtureId: string, options: { deckIndex?: number } = {}) => {
    const deckIndex = options.deckIndex ?? 0;
    expect(deckIndex, `a deck index inside L1's ${String(constants.DECKS_PER_LOADOUT)} decks`).to.be.within(
      0,
      constants.DECKS_PER_LOADOUT - 1,
    );
    return cy.fixture(`decks/${fixtureId}.json`).then((raw) => {
      const decks = loadoutFrom(asDeck(raw, fixtureId).cards, deckIndex);
      const ids = mintIds(constants.DECKS_PER_LOADOUT);
      const [first, second, third] = ids;
      if (first === undefined || second === undefined || third === undefined) {
        throw new Error("mintIds(3) did not yield three ids");
      }
      return cy.clearDecks(account).then((catalogVersion) => {
        decks.forEach((cards, at) => {
          cy.saveDeck(account, {
            id: ids[at] ?? mintId(),
            name: INSTALLED_DECK_NAMES[at] ?? `Deck ${String(at + 1)}`,
            cards,
            catalogVersion,
          });
        });
        return cy.saveTrio(account, { name: INSTALLED_TRIO_NAME, deckIds: [first, second, third] }).then(
          (trioId): InstalledLoadout => ({ deckIds: [first, second, third], trioId, decks, catalogVersion }),
        );
      });
    });
  },
);

// ---------------------------------------------------------------------------------------------
// Leaving nothing behind on the E2E server (§9.5, R259–R261)
// ---------------------------------------------------------------------------------------------

/** `GET /api/auth/me`, as far as the cleanup reads it. */
type MeBody = { currentMatchId: string | null; currentSeriesId?: string | null };

/** `GET /api/series/:id` (`SeriesView`), as far as the cleanup reads it. */
type SeriesStatusBody = { status: "picking" | "playing" | "over"; currentMatchId: string | null };

/**
 * §2.5: concede `matchId` as `account`, from a socket of its own (`wsPlayer`'s `concede`: connect,
 * concede and close in one task, so the account's browser cannot take the seat back in between).
 * Yields the task's answer; a match that was already over is not an error.
 */
Cypress.Commands.add("concedeAs", (account: E2EAccount, matchId: string) => {
  return cy
    .task<WsPlayerResult>(
      "wsPlayer",
      { action: "concede", name: `concede-${account.email}`, url: server.ws(), token: account.token, matchId },
      { timeout: timeouts.task },
    )
    .then((result) => {
      const refused = result.code === "match_over";
      expect(
        result.ok || refused,
        `${account.email} conceded ${matchId}: ${result.code ?? ""} ${result.error ?? "ok"}`,
      ).to.eq(true);
      return result;
    });
});

/**
 * How many things `cy.freeAccount` may have to undo: a match, then (in a series) the forfeit that
 * follows it, with room for a concede the account's own browser raced. Not a rule number: a bound
 * on a cleanup loop.
 */
const FREE_ACCOUNT_STEPS = 8;

/**
 * Take an account out of everything the E2E server could still hold it in: an open queue ticket
 * (`DELETE /api/queue`), a live match (a concede, §2.5) and a Best-of-3 series that is not over (a
 * forfeit between games, a concede of the game being played, R261). The server keeps its state for
 * its whole life, so a spec that failed half-way — or an earlier run of this one — would otherwise
 * answer the next `POST /api/queue` with 409 `already_in_match` or `already_queued`.
 *
 * Every step is re-read from `/api/auth/me`, and the loop has a budget, so a state this cannot
 * clear fails loudly here rather than as a misleading 409 later.
 */
Cypress.Commands.add("freeAccount", (account: E2EAccount) => {
  cy.request({ method: "DELETE", url: api("/api/queue"), headers: bearer(account.token), failOnStatusCode: false });
  const step = (left: number): void => {
    cy.request<MeBody>({ method: "GET", url: api("/api/auth/me"), headers: bearer(account.token) }).then(
      (response) => {
        const matchId = response.body.currentMatchId;
        const seriesId = response.body.currentSeriesId ?? null;
        if (matchId === null && seriesId === null) return;
        expect(left, `${account.email} is out of every match and series in time`).to.be.greaterThan(0);
        if (matchId !== null) {
          cy.concedeAs(account, matchId);
        } else if (seriesId !== null) {
          cy.request<SeriesStatusBody>({
            method: "GET",
            url: api(`/api/series/${seriesId}`),
            headers: bearer(account.token),
            failOnStatusCode: false,
          }).then((series) => {
            if (series.status !== 200) return;
            if (series.body.status === "picking") {
              cy.request({
                method: "POST",
                url: api(`/api/series/${seriesId}/forfeit`),
                headers: bearer(account.token),
                failOnStatusCode: false,
              });
            } else if (series.body.status === "playing" && series.body.currentMatchId !== null) {
              cy.concedeAs(account, series.body.currentMatchId);
            }
          });
        }
        step(left - 1);
      },
    );
  };
  step(FREE_ACCOUNT_STEPS);
});

/**
 * A11: drag a card from the pool into the open deck, in the deck workshop.
 *
 * A drag is a multi-event gesture — `dragstart` on the source with a `DataTransfer`, `dragover` and
 * `drop` on the target, `dragend` to let go — that no spec should hand-roll. The `DataTransfer` is
 * built in the app's own window so the events carry an object the page can read. The workshop has
 * one deck open at a time, so the target is its one drop region (`DECK_DROP`).
 */
Cypress.Commands.add("dragCardToDeck", (catalogCardId: string) => {
  const source = ts(poolCardId(catalogCardId));
  const target = ts(DECK_DROP);
  cy.get(source, { timeout: timeouts.view }).should("exist");
  cy.get(target).should("exist");

  cy.window({ log: false }).then((win) => {
    const dataTransfer = new win.DataTransfer();
    dataTransfer.setData(DECK_DRAG_MIME, catalogCardId);
    dataTransfer.setData("text/plain", catalogCardId);

    cy.get(source).trigger("dragstart", { dataTransfer, eventConstructor: "DragEvent" });
    cy.get(target).trigger("dragover", { dataTransfer, eventConstructor: "DragEvent" });
    cy.get(target).trigger("drop", { dataTransfer, eventConstructor: "DragEvent" });
    // The source may be gone or greyed out after a successful drop, so letting go is best-effort.
    exists(source).then((present) => {
      if (present) cy.get(source).trigger("dragend", { dataTransfer, eventConstructor: "DragEvent" });
    });
  });
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
    // §9.3: the server's own words. The code is a label on the failure, not a rewording of it.
    const why = result.code === undefined ? (result.error ?? "ok") : `[${result.code}] ${result.error ?? ""}`;
    expect(result.ok, `wsPlayer ${command.action}: ${why}`).to.eq(true);
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
      /** Keep every card in any open opening-mulligan prompt (R9, R265). */
      keepMulligans(): Chainable<void>;
      /** Click `concede`, then `concede-confirm` in the dialog it opens (§2.5). */
      concede(): Chainable<void>;
      /** Play a hand card, building its R81 play-time choices from the UI. */
      playCard(instanceId: string, options?: PlayCardOptions): Chainable<void>;
      /** Declare an attack against a unit or a hero (SPEC §4.2). */
      attack(attackerId: string, target: AttackTarget, options?: ActOptions): Chainable<void>;
      /** Answer the open prompt; `null` accepts whatever kind is open (SPEC §10.6). */
      answerPrompt(kind: PromptKind | null, answer?: PromptAnswer): Chainable<void>;
      /** Click `end-turn`, then hand the device over if the client asks for it. */
      endTurn(options?: ActOptions & { handOver?: boolean }): Chainable<void>;
      handOver(): Chainable<void>;
      switchPosition(instanceId: string, options?: ActOptions): Chainable<void>;
      offerDraw(): Chainable<void>;
      usePower(options?: ActOptions): Chainable<void>;
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
      /** The instance ids in a seat's hand (setup only: assertions belong on the DOM). */
      handIds(player: PlayerId): Chainable<string[]>;
      /** The top card of each of a seat's unit zones, in lane order (§3.2). */
      unitIds(player: PlayerId): Chainable<string[]>;
      /** End turns until `turn` is the current player-turn; R82-safe (§10.1). */
      advanceToTurn(turn: number, options?: { budget?: number }): Chainable<void>;
      /** Remember a fixture account, so every later visit boots signed in as it (A10). */
      signIn(account: E2EAccount): Chainable<E2EAccount>;
      /** Forget it again, so a later visit boots signed out. */
      signOut(): Chainable<void>;
      /** `cy.signIn(account)` then `cy.visit(path)`, session installed before the page runs. */
      visitAs(account: E2EAccount, path: string, options?: Partial<Cypress.VisitOptions>): Chainable<void>;
      /**
       * Replace an account's saved decks with a fixture deck at `deckIndex` and two padding decks,
       * plus a trio of the three (§9.4, R250–R253). Yields the ids.
       */
      installLoadout(account: E2EAccount, fixtureId: string, options?: { deckIndex?: number }): Chainable<InstalledLoadout>;
      /** `GET /api/decks` as `account`. */
      savedDecks(account: E2EAccount): Chainable<SavedDecksBody>;
      /** Delete every saved trio and deck of `account`; yields the server's catalog version. */
      clearDecks(account: E2EAccount): Chainable<string>;
      /** `PUT /api/decks/:id` as `account`; yields the id. */
      saveDeck(account: E2EAccount, deck: SaveDeckInput): Chainable<string>;
      /** `PUT /api/trios/:id` as `account`; yields the id. */
      saveTrio(account: E2EAccount, trio: SaveTrioInput): Chainable<string>;
      /** Concede `matchId` as `account` from a socket of its own (§2.5). */
      concedeAs(account: E2EAccount, matchId: string): Chainable<WsPlayerResult>;
      /** Dequeue, concede a live match and forfeit a series between games (§9.5, R261). */
      freeAccount(account: E2EAccount): Chainable<void>;
      /** Drag a pool card into the open deck in the workshop: the whole gesture, not one event (A11). */
      dragCardToDeck(catalogCardId: string): Chainable<void>;
      jackioh(): Chainable<JackiOhDevHandle>;
      gameState(): Chainable<GameStateLike>;
      dispatchAction(action: ActionInput): Chainable<void>;
      replayCheck(label: string): Chainable<void>;
      wsPlayer(command: WsPlayerCommand): Chainable<WsPlayerResult>;
      expectResult(text: "Win" | "Loss" | "Draw"): Chainable<void>;
    }
  }
}
