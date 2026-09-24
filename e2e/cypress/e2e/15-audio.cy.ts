// Polish task 2 (docs/polish/2-sound.md) `15-audio.cy.ts` — behaviours B38 and B39, on a real
// hotseat board in Chrome.
//
//   B38  On /dev/hotseat, before any gesture `__jackiohAudio.contextsCreated()` is 0. After one
//        click on the board it is 1 and `state()` is neither "locked" nor "unsupported", and
//        playing a unit from hand through the UI appends a `voice` log entry with that defId and
//        `line: "play"`.
//   B39  After clicking `audio-toggle` and reloading, the toggle is `aria-pressed="true"` and
//        playing a card appends nothing to the log, and `GET /audio/voice/core-004-play.m4a`
//        answers 200 with an `audio/*` content type.
//
// What this asserts is the voice REQUEST, never its outcome. Headless Chrome may keep the context
// suspended with no output device, and a Chromium without AAC falls back to speech; the engine logs
// an accepted cue either way (docs/polish/2-sound.md, Risks), so the log entry is the one thing that
// is the same on every machine.
//
// House rules (BUILD M8): the seed is set here and overridable with `--expose seed=…`; there is no
// fixed `cy.wait(ms)` — every wait is `cy.settled()` or a retried assertion; and every selector goes
// through `ts()`. `e2e/` does not import `apps/`, so the debug handle's shape is declared locally
// below (it mirrors `AudioDebugHandle` in apps/web/src/audio/debug.ts).
//
// The two 01-aggro fixture decks are used because every card in them is choice-free (see spec 01):
// playing a unit is a hand click plus a zone click and never opens a picker. Which unit is in hand
// depends on the shuffle, so the spec ends turns until the client offers a unit, and plays that.
//
// Run it with:
//   pnpm build:e2e
//   pnpm --dir apps/web exec vite preview --port 5172 --strictPort
//   E2E_BASE_URL=http://localhost:5172 pnpm --dir e2e exec cypress run --browser chrome \
//     --spec cypress/e2e/15-audio.cy.ts

import { seedFor } from "../../support/config.ts";
import { BOARD, LEGAL, cardId, handCardId, ts, zoneId } from "../../support/testids.ts";
import type { GameStateLike, Lane, PlayerId } from "../../support/types.ts";

/** Every spec sets a seed (BUILD M8). */
const SEED = seedFor("15-audio");
const DECK_A = "01-aggro-a";
const DECK_B = "01-aggro-b";

/** docs/polish/2-sound.md "Other surfaces". */
const AUDIO_TOGGLE = "audio-toggle";
const AUDIO_SETTINGS_KEY = "jackioh.audio.v1";
const CORE_004_PLAY_URL = "/audio/voice/core-004-play.m4a";

/**
 * The catalog's `type: "Unit"` cards among 01-aggro-a and 01-aggro-b (packages/cards/catalog.json).
 * The rest of those two decks are Spells and Field Spells, which speak a cast line, not a play line.
 */
const UNIT_DEF_IDS: ReadonlySet<string> = new Set([
  "core-001", "core-003", "core-008", "core-011", "core-015", "core-019", "core-020", "core-025",
  "core-032", "core-045", "core-053", "core-056", "core-077", "core-081", "core-089", "core-091",
  "core-092",
]);

/** Player-turns to wait for a unit the client offers. A 1- or 2-cost unit lands well inside it. */
const TURN_BUDGET = 8;

const LANES: readonly Lane[] = [1, 2, 3, 4, 5];

// ---------------------------------------------------------------------------------------------
// window.__jackiohAudio, declared locally (e2e/ does not import apps/)
// ---------------------------------------------------------------------------------------------

type VoiceLineKind = "play" | "death" | "cast";

type PlayedCueLike =
  | { kind: "sfx"; id: string; params?: { amount?: number; mine?: boolean }; delayMs: number; atMs: number }
  | { kind: "voice"; defId: string; line: VoiceLineKind; delayMs: number; atMs: number; outcome: string };

type AudioDebugHandleLike = {
  state(): string;
  log(): readonly PlayedCueLike[];
  clearLog(): void;
  contextsCreated(): number;
};

function audioHandle(win: Cypress.AUTWindow): AudioDebugHandleLike | undefined {
  return (win as unknown as { __jackiohAudio?: AudioDebugHandleLike }).__jackiohAudio;
}

/**
 * Assert on the live debug handle, retried until it holds. The handle is re-read from the window on
 * every retry, so a Game that remounts (a hotseat hand-over) never leaves the check holding a stale one.
 */
function expectAudio(check: (audio: AudioDebugHandleLike) => void): void {
  cy.window({ log: false }).should((win) => {
    const audio = audioHandle(win);
    expect(audio, "window.__jackiohAudio (outside production builds)").to.not.eq(undefined);
    if (audio !== undefined) check(audio);
  });
}

function clearAudioLog(): void {
  cy.window({ log: false }).then((win) => {
    const audio = audioHandle(win);
    expect(audio, "window.__jackiohAudio (outside production builds)").to.not.eq(undefined);
    audio?.clearLog();
  });
}

function voiceCues(audio: AudioDebugHandleLike): Extract<PlayedCueLike, { kind: "voice" }>[] {
  return audio.log().filter((cue): cue is Extract<PlayedCueLike, { kind: "voice" }> => cue.kind === "voice");
}

// ---------------------------------------------------------------------------------------------
// playing a unit through the UI
// ---------------------------------------------------------------------------------------------

type HandCard = { id: string; defId: string };

/** Which instance ids might be clicked (setup only; assertions read the DOM or the audio log). */
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

type Played = { instanceId: string; defId: string };

/**
 * Play the first unit the client offers from the active seat's hand: a hand click, then the
 * highlighted unit zone. Ends turns (handing the device over) until one is offered. `beforePlay`
 * runs right before the hand click, so the log can be cleared at exactly that point.
 */
function playOfferedUnit(played: Played, beforePlay: () => void, turnsLeft = TURN_BUDGET): void {
  cy.gameState().then((state) => {
    expect(turnsLeft, "the client offered a unit inside the turn budget").to.be.greaterThan(0);
    expect(state.result, "the game is still running").to.eq(null);
    const seat = state.active;
    ensureSeat(seat);
    const units = handOf(state, seat).filter((card) => UNIT_DEF_IDS.has(card.defId));

    firstLegal(units.map((card) => handCardId(card.id))).then((testid) => {
      if (testid === null) {
        // R82: a turn with nothing left to do may already have ended itself.
        cy.gameState().then((now) => {
          if (now.active === seat) cy.endTurn();
          else cy.handOver();
        });
        playOfferedUnit(played, beforePlay, turnsLeft - 1);
        return;
      }

      const card = units.find((unit) => handCardId(unit.id) === testid);
      expect(card, `the offered hand card ${testid}`).to.not.eq(undefined);
      played.instanceId = card?.id ?? "";
      played.defId = card?.defId ?? "";

      beforePlay();
      cy.get(ts(testid)).click();
      cy.settled();
      // R81: the zone travels in the `play` action and a board click finishes it (BUILD M5-T2).
      firstLegal(LANES.map((lane) => zoneId("you", "units", lane))).then((zone) => {
        if (zone !== null) {
          cy.get(ts(zone)).click();
          cy.settled();
        }
      });
      // The play really happened: the card left the hand and stands on the field.
      cy.get(ts(testid)).should("not.exist");
      cy.then(() => {
        cy.get(ts(cardId(played.instanceId))).should("exist");
      });
    });
  });
}

// ---------------------------------------------------------------------------------------------

describe("polish 2 — audio on the hotseat board", () => {
  it("B38 no AudioContext exists before a gesture, and one click on the board makes exactly one", () => {
    // `manual`: nothing is clicked on the way in, so this page has seen no gesture at all.
    cy.seedGame({ seed: SEED, a: DECK_A, b: DECK_B, mulligan: "manual" });

    expectAudio((audio) => {
      expect(audio.contextsCreated(), "no AudioContext before any gesture").to.eq(0);
      expect(audio.state(), "the engine waits for a gesture").to.eq("locked");
      expect(audio.log(), "nothing is accepted before a gesture").to.have.length(0);
    });

    // Inside the board's own 8px padding (board.css), clear of the centred mulligan panel and of the
    // top-right toggle; the prompt scrim is click-through (prompt.css), so the board takes the click.
    cy.get(ts(BOARD)).click(4, 4);

    expectAudio((audio) => {
      expect(audio.contextsCreated(), "the first gesture constructs one AudioContext").to.eq(1);
      expect(audio.state(), "the engine has left locked").to.not.be.oneOf(["locked", "unsupported"]);
    });

    // Later gestures resume the same context; they never build a second one.
    cy.keepMulligans();
    expectAudio((audio) => {
      expect(audio.contextsCreated(), "still exactly one AudioContext").to.eq(1);
    });
  });

  it("B38 playing a unit from hand through the UI logs a voice request for its play line", () => {
    // `keep` answers the mulligans through the UI: those clicks are the unlocking gesture.
    cy.seedGame({ seed: SEED, a: DECK_A, b: DECK_B });
    expectAudio((audio) => {
      expect(audio.contextsCreated(), "the mulligan clicks unlocked audio").to.eq(1);
      expect(audio.state()).to.not.be.oneOf(["locked", "unsupported"]);
    });

    const played: Played = { instanceId: "", defId: "" };
    playOfferedUnit(played, clearAudioLog);

    expectAudio((audio) => {
      const lines = voiceCues(audio).filter((cue) => cue.defId === played.defId && cue.line === "play");
      expect(played.defId, "a unit was played").to.not.eq("");
      expect(
        lines,
        `one voice request for ${played.defId}'s play line (log: ${JSON.stringify(audio.log())})`,
      ).to.have.length(1);
    });
  });

  it("B39 a mute survives a reload, and a unit played while muted logs nothing", () => {
    cy.seedGame({ seed: SEED, a: DECK_A, b: DECK_B });

    cy.get(ts(AUDIO_TOGGLE)).should("have.attr", "aria-pressed", "false");
    cy.get(ts(AUDIO_TOGGLE)).click();
    cy.get(ts(AUDIO_TOGGLE)).should("have.attr", "aria-pressed", "true");
    cy.window({ log: false }).should((win) => {
      const stored = JSON.parse(win.localStorage.getItem(AUDIO_SETTINGS_KEY) ?? "null") as { muted?: unknown } | null;
      expect(stored?.muted, `localStorage["${AUDIO_SETTINGS_KEY}"].muted`).to.eq(true);
    });

    // The hotseat route finds its decks again in the localStorage copy `seedGame` left.
    cy.reload();
    cy.jackioh().should((handle) => {
      expect(handle.seed, "the same seeded game after the reload").to.eq(SEED);
    });
    cy.settled();
    cy.get(ts(AUDIO_TOGGLE)).should("have.attr", "aria-pressed", "true");

    // Gestures still unlock audio while muted, so an empty log below is the mute and not a lock.
    cy.keepMulligans();
    expectAudio((audio) => {
      expect(audio.contextsCreated(), "the mulligan clicks unlocked audio").to.eq(1);
      expect(audio.state()).to.not.be.oneOf(["locked", "unsupported"]);
      expect(audio.log(), "muted: not even the mulligan clicks are accepted").to.have.length(0);
    });

    const played: Played = { instanceId: "", defId: "" };
    playOfferedUnit(played, clearAudioLog);

    cy.get(ts(AUDIO_TOGGLE)).should("have.attr", "aria-pressed", "true");
    expectAudio((audio) => {
      expect(played.defId, "a unit was played").to.not.eq("");
      expect(audio.log(), `muted: playing ${played.defId} appends nothing`).to.deep.eq([]);
    });
  });

  it("B39 GET /audio/voice/core-004-play.m4a answers 200 with an audio content type", () => {
    cy.request({ url: CORE_004_PLAY_URL, encoding: "binary" }).then((response) => {
      expect(response.status, `GET ${CORE_004_PLAY_URL}`).to.eq(200);
      const header: unknown = response.headers["content-type"];
      const contentType = Array.isArray(header) ? header.join(", ") : String(header ?? "");
      expect(contentType, "content-type").to.match(/^audio\//);
      expect(String(response.body).length, "a non-empty body").to.be.greaterThan(0);
    });
  });
});
