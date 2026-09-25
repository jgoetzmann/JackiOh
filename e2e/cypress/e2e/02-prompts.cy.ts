// BUILD M8 `02-prompts.cy.ts` — "One deck containing Jewelosco Scarab, Hit Job, Flood (radiant),
// Archivist, Glowy Jelly Bean, Zoomerbin Oomen, Lava Golem, Silly Silas, Efficiency Dividend,
// Suppressive Aura".
//
// Key assertions (BUILD M8's table, verbatim):
//
//   "each choice picker (`discover, target, mode, hand, zone, tribute, direction, x, embiggen,
//    mulligan`) is rendered once and answered, whether it builds the `play` action or answers a
//    `PendingChoice` (R81)"
//
// That last clause is the whole spec. R81 splits the ten kinds in two and §10.6 names both halves:
//
//   * A `PendingChoice` (SPEC §10.6) — the engine paused mid-resolution and `state.pending` holds
//     the question. Here: `discover` (Jewelosco Scarab's Cry) and `mulligan` (§2.1, R9). Answering
//     it is an `answer` action (the mulligan has its own `mulligan` action, §10.2). The mulligan is
//     the one kind asked of both seats at once (R265): its two `PendingChoice`s sit in
//     `state.mulligan`, one per seat, and `state.pending` stays null for the whole window.
//   * A play-time choice (R81, R123) — "Zone, X, embiggen, Tribute and the targets and modes a
//     card's script declares travel in the `play` action, which `legalActions` enumerates; the
//     client builds them with the prompt pickers." Nothing is paused and `state.pending` is null;
//     the picker is building a `play`. Here: `zone`, `target` (Hit Job), `mode` (radiant Flood),
//     `hand` (Glowy Jelly Bean — a declared hand pick travels in `targets`), `tribute` (Lava
//     Golem — R123: the units travel in `targets` and the amount in `tributes`), `direction`
//     (Silly Silas — a declared direction travels in `modes`), `x` (Efficiency Dividend) and
//     `embiggen` (Suppressive Aura).
//
// Both halves render the same picker with the same `data-prompt-kind`, which is why one assertion
// covers both: the picker for the kind under test is open exactly once, it is answered through the
// UI, it closes, and the effect the answer asked for is visible on the board afterwards. The last
// part matters — a picker that is rendered and dismissed without its answer reaching `reduce`
// would satisfy "rendered and answered" and nothing else.
//
// One `it` per kind, each on its own seeded game, because ten pickers cannot be reached in one
// game: player 1 draws three cards plus one a turn and the hand caps at ten (§2.4, R4), so a card
// that has not arrived within seven turns is burned rather than drawn. Each seed below was chosen
// against `02-prompts-a` so the cards that test needs are in the opening hand or the first draws;
// `--expose seed=…` overrides all ten at once, and `toP1Turn` waits for the cards rather than
// assuming the turn they land in, so a re-shuffle costs turns and not a red spec.
//
// BUILD M8's deck also names Archivist, whose "choose one: highest or lowest" is the deck's second
// `mode` source (R81 lists #30). It is deliberately unused: the assertion is that each picker is
// rendered ONCE, and radiant Flood is the mode picker BUILD annotates "(radiant)" — which is what
// Glowy Jelly Bean is in the deck for, since base Flood declares no mode at all.

import { seedFor } from "../../support/config.ts";
import {
  GAME,
  MULLIGAN_OPPONENT_READY,
  MULLIGAN_OPPONENT_STATUS,
  PROMPT,
  RADIANT,
  cardId,
  graveyardCountId,
  handCardId,
  heroId,
  promptOf,
  ts,
  zoneId,
} from "../../support/testids.ts";
import type { GameStateLike, PlayerId, PromptKind } from "../../support/types.ts";

/** Every spec sets a seed (BUILD M8). One per `it`, chosen so its cards arrive in the first turns. */
const SEEDS = {
  mulligan: seedFor("02-mulligan-0"),
  zone: seedFor("02-zone-0"),
  discover: seedFor("02-discover-1"),
  target: seedFor("02-target-70"),
  hand: seedFor("02-hand-1"),
  mode: seedFor("02-mode-16"),
  tribute: seedFor("02-tribute-1359"),
  direction: seedFor("02-direction-5"),
  x: seedFor("02-x-5"),
  embiggen: seedFor("02-embiggen-0"),
};

/**
 * The stat hooks BUILD M5-T4's acceptance rows read off a card ("stat numbers ... equal the
 * view's"). They are not in `e2e/support/testids.ts`, so they are spelled once here rather than at
 * each use, and adding them to support is reported.
 */
const attackIs = (n: number): string => `[data-attack="${n}"]`;
const healthIs = (n: number): string => `[data-health="${n}"]`;
const maxHealthIs = (n: number): string => `[data-max-health="${n}"]`;
const armorIs = (n: number): string => `[data-armor="${n}"]`;

/**
 * One seat's hand, read off `window.__jackioh.state` with the same cast `support/commands.ts` uses
 * in `instanceInHand`. Used to decide what to click and to read the opening hand the mulligan is
 * asked about; every other assertion reads the DOM, which is `viewFor` (CLAUDE.md rule 7).
 */
function handOf(state: GameStateLike, player: PlayerId): string[] {
  const side = state.players[player] as { hand?: { id: string; defId: string }[] };
  return (side.hand ?? []).map((card) => card.id);
}

/**
 * The options of the open `PendingChoice` (§10.6: `{ id, playerId, kind, options, min, max,
 * resume }`, each option `{ key, label, selection }`).
 *
 * Only the two `PendingChoice` tests need this, and only because a Discover's options are drawn
 * from the catalog by the match rng (§6.3, R60): no spec can name a key that the shuffle invented.
 * `support/types.ts` narrows `pending` to the fields the rest of the suite reads, so the shape is
 * spelled out here. A positional answer in support — `cy.answerPrompt(kind, { first: 1 })` — would
 * delete this helper, and is reported.
 */
type PendingPeek = NonNullable<GameStateLike["pending"]> & {
  options?: { key: string; label?: string; selection?: { pick: string; option?: string } }[];
};

function pendingOptions(): Cypress.Chainable<NonNullable<PendingPeek["options"]>> {
  return cy.gameState().then((state) => {
    const pending = state.pending === null ? null : (state.pending as PendingPeek);
    expect(pending, "a PendingChoice is open (§10.6)").to.not.eq(null);
    const options = pending?.options ?? [];
    expect(options, "the open choice offers options").to.not.have.length(0);
    return cy.wrap(options, { log: false });
  });
}

/** BUILD M5-T3: a hotseat device is handed over, so put it on the seat that has to act. */
function ensureSeat(player: PlayerId): void {
  cy.jackioh().then((handle) => {
    expect(handle.seat, "window.__jackioh.seat (the hotseat handle names the seat holding it)").to.not.eq(
      undefined,
    );
    if (handle.seat !== player) cy.handOver();
  });
}

function openGame(seed: string, mulligan: "keep" | "manual" = "keep"): void {
  cy.seedGame({ seed, a: "02-prompts-a", b: "02-prompts-b", mulligan });
}

/**
 * End turns until player 1's `k`-th turn is the current one — player-turn 2k-1 (§10.1: `turn` is a
 * 1-based player-turn counter), where player 1 has min(k, 4) mana (§2.3). Player 2's deck plays
 * nothing, so its turns are a bare hand-over.
 */
function toP1Turn(k: number, budget = 12): void {
  cy.gameState().then((state) => {
    expect(budget, `player 1's turn ${k} is reachable inside the budget`).to.be.greaterThan(0);
    if (state.turn === 2 * k - 1) {
      ensureSeat("p1");
      return;
    }
    ensureSeat(state.active);
    cy.endTurn();
    toP1Turn(k, budget - 1);
  });
}

/** Click the named hand card, which starts the play and opens its first R81 picker (M5-T2). */
function select(name: string): void {
  cy.handCardByName(name).then((instanceId) => {
    cy.get(ts(handCardId(instanceId))).click();
  });
}

/** "rendered once": one picker of this kind is open, and it is the only prompt on screen. */
function pickerOpensOnce(kind: PromptKind): void {
  cy.waitForPrompt(kind);
  cy.get(promptOf(kind)).should("have.length", 1);
  cy.get(PROMPT).should("have.length", 1);
}

/** "answered": the picker is gone, which for a play-time picker means the `play` was sent. */
function pickerAnswered(kind: PromptKind): void {
  cy.get(promptOf(kind)).should("not.exist");
}

describe("BUILD M8 02 — every choice picker is rendered once and answered", () => {
  it("R9 mulligan — both opening mulligans are open at once (R265), and the cards not kept are redrawn", () => {
    // `manual` leaves the prompts open: this is the one test that answers them itself.
    openGame(SEEDS.mulligan, "manual");
    pickerOpensOnce("mulligan");

    cy.gameState().then((state) => {
      // R265: both mulligans open with the deal. Each is a `PendingChoice`, but neither is
      // `state.pending` — §10.1 allows one open prompt, and the two mulligans are the one sealed-bid
      // step beside it — so the window is `state.mulligan`, one seat each, both still owing.
      // `playerId`-style reads of `pending` do not apply: this is the raw hotseat `GameState`.
      expect(state.pending, "R265: the mulligans are not `state.pending`").to.eq(null);
      expect(state.mulligan, "R265: both seats' mulligans are open").to.not.eq(undefined);
      expect(state.mulligan?.p1.keep, "player 1 owes its mulligan").to.eq(null);
      expect(state.mulligan?.p2.keep, "and player 2 owes its own at the same time").to.eq(null);
      expect(state.mulligan?.p1.prompt?.kind, "player 1's is a mulligan PendingChoice").to.eq("mulligan");
      expect(state.mulligan?.p2.prompt?.kind, "and so is player 2's").to.eq("mulligan");
      const hand = handOf(state, "p1");
      expect(hand, "player 1's opening hand is three cards (§2.1)").to.have.length(3);
      const kept = hand.slice(0, 1);
      const returned = hand.slice(1);

      // The device starts with player 1, whose picker says the opponent has not answered yet.
      cy.get(ts(GAME)).should("have.attr", "data-viewer", "p1");
      cy.get(promptOf("mulligan")).find(ts(MULLIGAN_OPPONENT_STATUS)).should("have.attr", "data-ready", "false");

      // §2.1 / R9: the picked cards are the ones KEPT; the rest are returned, replacements are
      // drawn first and only then are the returned cards shuffled back in. The picker opens with
      // every card kept (Hearthstone's default), so the cards clicked are the ones sent back.
      cy.get(promptOf("mulligan"))
        .find('[aria-pressed="true"]')
        .should("have.length", hand.length);
      cy.answerPrompt("mulligan", { cards: returned, submit: true });

      // R266: player 1's answer is SEALED. It is stored as the ids kept and nothing else moves until
      // the other seat's answer is in — player 1's hand is exactly the hand it was dealt.
      cy.gameState().should((mid) => {
        expect(mid.pending, "still no `state.pending` while player 2 owes its mulligan").to.eq(null);
        expect(mid.mulligan?.p1.keep, "R266: player 1's sealed answer is the ids it keeps").to.deep.eq(kept);
        expect(mid.mulligan?.p2.keep, "player 2 still owes its own").to.eq(null);
        expect(handOf(mid, "p1"), "R266: a sealed answer changes no hand yet").to.deep.eq(hand);
        expect(mid.phase, "the game is still in the mulligan").to.eq("mulligan");
      });

      // NOT `pickerAnswered("mulligan")`: the device follows the seat that still owes its mulligan
      // (BUILD M5-T3, `hotseat.ts`), so player 2's own picker — the one that has been open since the
      // deal — is on screen now, and it says player 1 is ready. Both pickers carry
      // `data-prompt-kind="mulligan"`, so "not.exist" could never hold here.
      cy.get(ts(GAME)).should("have.attr", "data-viewer", "p2");
      pickerOpensOnce("mulligan");
      cy.get(promptOf("mulligan"))
        .find(ts(MULLIGAN_OPPONENT_STATUS))
        .should("have.attr", "data-ready", "true")
        .find(ts(MULLIGAN_OPPONENT_READY))
        .should("be.visible");

      // Player 2's answer is the second, so it resolves both in seat order and starts turn 1.
      cy.keepMulligans();
      cy.noPrompt();

      cy.gameState().should((after) => {
        const now = handOf(after, "p1");
        // Three replacements plus R10's turn-1 draw. Both mulligans are answered by the line above,
        // so the game has left the mulligan phase and player 1's first turn has begun — and R10
        // ("First player's turn-1 draw — Yes, draws") gives them a fourth card. Asserting three
        // here would be asserting that R10 does not happen.
        expect(now, "R9's three replacements, plus R10's turn-1 draw").to.have.length(4);
        expect(now, "the kept card stayed in hand").to.include(kept[0]);
        for (const id of returned) {
          expect(now, "a returned card left the hand").to.not.include(id);
        }
        expect(after.phase, "the game leaves the mulligan phase once both seats answer").to.not.eq(
          "mulligan",
        );
        expect(after.mulligan, "R265: the window closes with the second answer").to.eq(undefined);
      });
    });
  });

  it("R81 zone — playing a permanent asks for its zone and the unit lands in the lane chosen", () => {
    openGame(SEEDS.zone);
    ensureSeat("p1");

    // #67 Zoomerbin Oomen, one mana. A permanent needs an empty unlocked zone in its row (§3.2)
    // and the player picks it, so the zone picker offers all five empty unit lanes.
    select("Zoomerbin Oomen");
    pickerOpensOnce("zone");
    cy.gameState().should((state) => {
      expect(state.pending, "R81: a zone is a play choice, so nothing is paused").to.eq(null);
    });

    cy.answerPrompt("zone", { zones: [{ side: "you", row: "units", lane: 3 }] });
    pickerAnswered("zone");

    cy.fieldCardByName("Zoomerbin Oomen").then((oomen) => {
      cy.get(ts(zoneId("you", "units", 3))).find(ts(cardId(oomen))).should("exist");
      // R64 would have put an unnamed summon in the leftmost empty lane; the answer moved it.
      cy.get(ts(zoneId("you", "units", 1))).find(ts(cardId(oomen))).should("not.exist");
    });
  });

  it("R81 discover — Jewelosco Scarab's Cry opens a Discover and the chosen card reaches the hand", () => {
    openGame(SEEDS.discover);
    ensureSeat("p1");

    // #7's Cry is "Discover a 2-cost card": a choice made while the card resolves, so §9.3 makes it
    // a `PendingChoice` and not part of the play action.
    select("Jewelosco Scarab");
    pickerOpensOnce("zone");
    cy.answerPrompt("zone", { zones: [{ side: "you", row: "units", lane: 1 }] });

    pickerOpensOnce("discover");
    cy.gameState().should((state) => {
      expect(state.pending, "a Discover pauses resolution (§9.3, §10.6)").to.not.eq(null);
    });

    pendingOptions().then((options) => {
      expect(options, "Discover offers 3 options, drawn without replacement (§6.3)").to.have.length(3);
      const chosen = options[0];
      expect(chosen, "the first option").to.not.eq(undefined);
      const defId = chosen?.selection?.option ?? "";
      expect(defId, "a Discover option names the card it would add").to.not.eq("");

      cy.answerPrompt("discover", { options: options.slice(0, 1).map((option) => option.key) });
      pickerAnswered("discover");
      cy.noPrompt();

      cy.gameState().should((after) => {
        const side = after.players.p1 as { hand?: { defId: string }[] };
        const defIds = (side.hand ?? []).map((card) => card.defId);
        expect(defIds, "the discovered card is in hand").to.include(defId);
      });
    });
  });

  it("R81 target — Hit Job asks which unit to destroy and destroys exactly that one", () => {
    openGame(SEEDS.target);
    ensureSeat("p1");

    // #15 Me and Mr Token is two bodies for one mana (itself plus a Rush Token, which R64 puts in
    // the leftmost empty lane — lane 2), so Hit Job's declared target has more than one candidate
    // and the picker has to ask (R90). The two are told apart by lane rather than by name: the
    // token's name is inside Me and Mr Token's own card text, so a name lookup would be ambiguous.
    cy.playByName("Me and Mr Token", { zone: { side: "you", row: "units", lane: 1 } });

    cy.instanceAt("p1", "units", 1).then((victim) => {
      cy.instanceAt("p1", "units", 2).should("not.eq", "");
      toP1Turn(2);
      select("Hit Job");
      pickerOpensOnce("target");
      cy.gameState().should((state) => {
        expect(state.pending, "R81: a declared target travels in the play action").to.eq(null);
      });

      cy.answerPrompt("target", { cards: [victim] });
      pickerAnswered("target");

      cy.get(ts(cardId(victim))).should("not.exist");
      cy.instanceAt("p1", "units", 2).then((token) => {
        cy.get(ts(cardId(token))).should("exist");
      });
      // The destroyed unit and the resolved spell (§5.1) are both in the graveyard; the Rush Token
      // would not be, since a unit token never enters one (R11).
      cy.get(ts(graveyardCountId("you"))).should("have.text", "2");
    });
  });

  it("R81 hand — Glowy Jelly Bean asks for a card in hand and that card becomes Radiant", () => {
    openGame(SEEDS.hand);
    // #26 costs 3, so player 1's third turn is the first that can pay for it (§2.3).
    toP1Turn(3);

    cy.handCardByName("Jewelosco Scarab").then((scarab) => {
      select("Glowy Jelly Bean");
      // R81: "a declared `hand` ... pick travels in `targets` ... chosen with the play and never
      // pauses resolution", so this is a play-time picker even though it names a card in hand.
      pickerOpensOnce("hand");
      cy.gameState().should((state) => {
        expect(state.pending, "R81: a declared hand pick is not a PendingChoice").to.eq(null);
      });

      cy.answerPrompt("hand", { cards: [scarab] });
      pickerAnswered("hand");

      // §5.2: in hand the cost is unchanged and the stats and text swap to the radiant form.
      cy.get(ts(handCardId(scarab))).should("have.attr", "data-radiant", "true");
      cy.get(`${ts(handCardId(scarab))}${RADIANT}`).should("exist");
    });
  });

  it("R81 mode — radiant Flood asks which of its three effects to run and runs that one", () => {
    openGame(SEEDS.mode);
    ensureSeat("p1");

    // A unit to bounce, so the mode that was picked is visible in the result.
    cy.playByName("Mr. Vanilla", { zone: { side: "you", row: "units", lane: 1 } });

    // Base #17 is "bounce all units on both sides" and declares no mode at all; the three-way
    // choice is the radiant face (§8.1), so Glowy Jelly Bean makes Flood radiant first.
    toP1Turn(3);
    cy.handCardByName("Flood").then((flood) => {
      select("Glowy Jelly Bean");
      cy.answerPrompt("hand", { cards: [flood] });
      cy.get(ts(handCardId(flood))).should("have.attr", "data-radiant", "true");

      toP1Turn(4);
      cy.fieldCardByName("Mr. Vanilla").then((vanilla) => {
        select("Flood");
        pickerOpensOnce("mode");
        cy.gameState().should((state) => {
          expect(state.pending, "R81: a declared mode travels in the play action").to.eq(null);
        });

        // The option strings are the card's own public interface, word for word from §8.1:
        // "Choose one: bounce all units, bounce all enemy units, destroy all enemy units".
        cy.answerPrompt("mode", { options: ["bounce all units"] });
        pickerAnswered("mode");

        cy.get(ts(cardId(vanilla))).should("not.exist");
        cy.get(ts(handCardId(vanilla))).should("exist");
      });
    });
  });

  it("R123 tribute — Lava Golem asks which units pay Tribute 3 and sacrifices exactly those", () => {
    openGame(SEEDS.tribute);
    ensureSeat("p1");

    // Four bodies for two mana across two turns: #15 brings its Rush Token with it (R64), so the
    // board holds four units and Tribute 3 has four minimal paying sets — R101 makes the set
    // minimal, which is what makes the picker ask instead of taking the only answer there is.
    cy.playByName("Me and Mr Token", { zone: { side: "you", row: "units", lane: 1 } });
    toP1Turn(2);
    cy.playByName("Tempo Timmy", { zone: { side: "you", row: "units", lane: 3 } });
    cy.playByName("Mr. Vanilla", { zone: { side: "you", row: "units", lane: 4 } });

    toP1Turn(3);
    // By lane, not by name: the Rush Token in lane 2 renders "Rush Token", which is also inside
    // Me and Mr Token's own card text, so only the lane says which unit is which.
    cy.instanceAt("p1", "units", 1).then((mrToken) => {
      cy.instanceAt("p1", "units", 3).then((timmy) => {
        cy.instanceAt("p1", "units", 4).then((vanilla) => {
          select("Lava Golem");
          pickerOpensOnce("tribute");
          cy.gameState().should((state) => {
            expect(state.pending, "R123: a Tribute is paid inside the play action").to.eq(null);
          });

          // Three picks and a confirm: §6.3's Tribute 3, with every unit here worth 1 (only a
          // Sheep Token counts 2, §3.2).
          cy.answerPrompt("tribute", { cards: [mrToken, timmy, vanilla], submit: true });
          pickerAnswered("tribute");

          for (const id of [mrToken, timmy, vanilla]) {
            cy.get(ts(cardId(id))).should("not.exist");
          }
          // The three sacrificed cards are deaths (§6.3 Sacrifice), and the Rush Token that was
          // not picked is still in lane 2 — a unit token never reaches a graveyard (R11), so the
          // count is three and not four.
          cy.get(ts(graveyardCountId("you"))).should("have.text", "3");
          cy.instanceAt("p1", "units", 2).then((token) => {
            cy.get(ts(cardId(token))).should("exist");
          });
          // #55 is a 10/5 with Armor 3 and Taunt. Lane 5 is the only zone that was open when the
          // play was built, so that is where the golem the Tribute paid for stands.
          cy.instanceAt("p1", "units", 5).then((golem) => {
            cy.get(ts(cardId(golem))).find(attackIs(10)).should("exist");
            cy.get(ts(cardId(golem))).find(armorIs(3)).should("exist");
          });
        });
      });
    });
  });

  it("R81 direction — Silly Silas asks left or right and every card moves one lane that way", () => {
    openGame(SEEDS.direction);
    ensureSeat("p1");

    cy.playByName("Tempo Timmy", { zone: { side: "you", row: "units", lane: 1 } });

    toP1Turn(3);
    cy.fieldCardByName("Tempo Timmy").then((timmy) => {
      select("Silly Silas");

      // R81: "a declared `direction` pick travels in `modes`", so this is a play choice too — and
      // the client draws it as its own picker kind (`data-prompt-kind="direction"`). A mode is
      // asked before the zone, because the zone is the click that finishes the play (M5-T2).
      pickerOpensOnce("direction");
      cy.gameState().should((state) => {
        expect(state.pending, "R81: a declared direction travels in the play action").to.eq(null);
      });
      cy.answerPrompt("direction", { options: ["right"] });
      pickerAnswered("direction");

      cy.answerPrompt("zone", { zones: [{ side: "you", row: "units", lane: 2 }] });

      // §3.1 / R14: the unit zones are one ring, your lanes 1→5 then the opponent's 5→1, and
      // "rotate right moves every card one step around its ring" — Silas rotates too.
      cy.fieldCardByName("Silly Silas").then((silas) => {
        cy.get(ts(zoneId("you", "units", 2))).find(ts(cardId(timmy))).should("exist");
        cy.get(ts(zoneId("you", "units", 3))).find(ts(cardId(silas))).should("exist");
      });
    });
  });

  it("R81 x — Efficiency Dividend asks for X, a target and a mode, and deals exactly X", () => {
    openGame(SEEDS.x);
    // #24 costs X: 0 ≤ X ≤ current mana (§2.3), so a two-mana turn offers 0, 1 and 2.
    toP1Turn(2);

    select("Efficiency Dividend");
    pickerOpensOnce("x");
    cy.gameState().should((state) => {
      expect(state.pending, "R81: X is chosen at play time, not by a prompt").to.eq(null);
    });
    cy.answerPrompt("x", { x: 2 });

    // The same play still owes its declared target and mode, in the order the client asks them.
    pickerOpensOnce("target");
    cy.answerPrompt("target", { hero: "opponent" });
    pickerOpensOnce("mode");
    // §8.2: "Choose one: deal X damage to a target; heal a target 2X; gain floor(X/2) mana next
    // turn" — the card's declared option for the first of those.
    cy.answerPrompt("mode", { options: ["damage"] });
    pickerAnswered("mode");

    // X = 2 through the §4.4 pipeline with no Armor and no cap in the way: 30 − 2 = 28.
    cy.get(ts(heroId("opponent"))).find(healthIs(28)).should("exist");
  });

  it("R81 embiggen — Suppressive Aura asks which price was paid and the aura matches that price", () => {
    openGame(SEEDS.embiggen);
    // Both prices have to be affordable for there to be a choice: #46 is "2 embiggen 4", so the
    // picker can only appear on a four-mana turn (§2.3, R65).
    toP1Turn(4);
    cy.playByName("4-mana 7/7", { zone: { side: "you", row: "units", lane: 1 } });

    toP1Turn(5);
    cy.fieldCardByName("4-mana 7/7").then((sevens) => {
      select("Suppressive Aura");
      pickerOpensOnce("embiggen");
      cy.gameState().should((state) => {
        expect(state.pending, "R81: the embiggen price is a play choice").to.eq(null);
      });
      // The embiggen picker's two options are the two prices; `true` is the embiggened one.
      cy.answerPrompt("embiggen", { options: ["true"] });
      pickerAnswered("embiggen");

      cy.answerPrompt("zone", { zones: [{ side: "you", row: "backrow", lane: 1 }] });

      // §8.2: "Aura: all units −2/−2 (paid 4: −5/−5)". The price that was picked is the only thing
      // that decides which, so a 7/7 standing at 2/2 is the answer having reached `reduce`
      // (§10.4 layer 5 lowers max health; current health = max − damage).
      cy.get(ts(cardId(sevens))).find(attackIs(2)).should("exist");
      cy.get(ts(cardId(sevens))).find(healthIs(2)).should("exist");
      cy.get(ts(cardId(sevens))).find(maxHealthIs(2)).should("exist");
    });
  });
});
