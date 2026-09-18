// The five commands BUILD's repo layout names — seedGame, playCard, attack, answerPrompt,
// endTurn — plus the waiting primitives that let the suite obey the M8 house rule: no fixed
// `cy.wait(ms)` anywhere. Every wait here is an assertion Cypress retries (a testid appearing, or
// `data-animating` clearing), never a sleep.
//
// All DOM knowledge lives in support/testids.ts. All URL and account knowledge lives in
// support/config.ts. A spec should not contain a raw selector.

import { CARD_NAMES, cardId as catalogId } from "./cards.ts";
import { constants, hotseatUrl, timeouts } from "./config.ts";
import {
  ANIMATING,
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

export type PlayCardOptions = {
  /** R81: the zone travels in the play action; the client builds it from a board click. */
  zone?: ZoneRef;
  /** R81: further play-time pickers (targets, modes, X, embiggen, tribute), in the order shown. */
  answers?: PromptStep[];
};

export type AttackTarget = { card: string } | { hero: Side };

export type WsPlayerCommand =
  | { action: "connect"; name: string; url?: string; token?: string; matchId?: string; roomCode?: string }
  | { action: "joinRoom"; name: string; roomCode: string }
  | { action: "send"; name: string; body: ActionInput }
  | { action: "awaitView"; name: string; where?: { active?: PlayerId; phase?: string; promptKind?: string; hasResult?: boolean } }
  | { action: "view"; name: string }
  | { action: "messages"; name: string }
  | { action: "disconnect"; name: string }
  | { action: "reset" };

export type WsPlayerResult = {
  ok: boolean;
  name?: string;
  view?: Record<string, unknown> | null;
  messages?: { type: string; [key: string]: unknown }[];
  error?: string;
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

/** R9: the opening mulligan. Keeping everything is one submit with nothing toggled. */
Cypress.Commands.add("keepMulligans", () => {
  const drain = (remaining: number): void => {
    if (remaining === 0) return;
    exists(promptOf("mulligan")).then((open) => {
      if (!open) return;
      cy.get(promptOf("mulligan")).within(() => {
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
  cy.settled();
});

Cypress.Commands.add("attack", (attackerId: string, target: AttackTarget) => {
  cy.get(ts(cardId(attackerId)), { timeout: timeouts.view }).click();
  if ("hero" in target) {
    cy.get(ts(heroId(target.hero))).click();
  } else {
    cy.get(ts(cardId(target.card))).click();
  }
  cy.settled();
});

Cypress.Commands.add("answerPrompt", (kind: PromptKind | null, answer: PromptAnswer = {}) => {
  const root = kind === null ? PROMPT : promptOf(kind);
  cy.get(root, { timeout: timeouts.view }).should("be.visible");

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
    (answer.options?.length ?? 0) + (answer.cards?.length ?? 0) + (answer.zones?.length ?? 0);
  const needsSubmit = answer.submit ?? (picks > 1 || answer.x !== undefined);
  if (needsSubmit) {
    cy.get(root).within(() => {
      cy.get(ts(PROMPT_SUBMIT)).click();
    });
  }
  cy.settled();
});

Cypress.Commands.add("endTurn", (options: { handOver?: boolean } = {}) => {
  cy.get(ts(END_TURN), { timeout: timeouts.view }).should("not.be.disabled");
  cy.get(ts(END_TURN)).click();
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

Cypress.Commands.add("switchPosition", (instanceId: string) => {
  cy.get(ts(switchPositionId(instanceId))).click();
  cy.settled();
});

Cypress.Commands.add("offerDraw", () => {
  cy.get(ts(OFFER_DRAW)).click();
  cy.settled();
});

Cypress.Commands.add("usePower", () => {
  cy.get(ts(POWER)).click();
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
