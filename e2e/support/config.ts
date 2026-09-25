// Routes, endpoints and fixture accounts the suite talks to. Everything is overridable from the
// Cypress env so the web/server teams can move a route without editing twelve specs:
//
//   pnpm --dir e2e test:e2e --expose wsUrl=ws://127.0.0.1:8787/ws/match
//
// BUILD M8 fixes only the hotseat route (`/dev/hotseat?seed=&a=&b=`). The rest is ASSUMPTION A6.
//
// Cypress 16 replaced `Cypress.env()` with the `expose` config object and `Cypress.expose()`,
// so overrides come from `expose` in cypress.config.ts or `--expose key=value` on the CLI.

function env(key: string, fallback: string): string {
  const value: unknown = Cypress.expose(key);
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/**
 * A spec's seed, overridable so CI can re-run one spec over many seeds:
 * BUILD §4 asks for "a nightly run of `01` over 20 seeds".
 *
 *   pnpm test:e2e --spec cypress/e2e/01-hotseat-full-game.cy.ts --expose seed=7
 */
export function seedFor(fallback: string): string {
  return env("seed", fallback);
}

/** BUILD M5-T3: the hotseat route, the only route M8 names. */
export function hotseatUrl(seed: string, a: string, b: string): string {
  const params = new URLSearchParams({ seed, a, b });
  return `/dev/hotseat?${params.toString()}`;
}

/** A6: routes for the specs M8 points at features rather than URLs. */
export const routes = {
  login: () => env("loginRoute", "/login"),
  invite: () => env("inviteRoute", "/invite"),
  deckbuilder: () => env("deckbuilderRoute", "/decks"),
  play: () => env("playRoute", "/play"),
  /** A networked match; the room-code screen lives here too. */
  match: (matchId: string) => `${env("matchRoute", "/match")}/${matchId}`,
  /** A Best-of-3 series between its games (R259): `paths.series` in apps/web/src/net/navigate.ts. */
  series: (seriesId: string) => `${env("seriesRoute", "/series")}/${seriesId}`,
};

/**
 * A6: the `E2E=1` server the networked specs (05, 06, 07, 10) talk to.
 *
 * The socket path is not an assumption: `apps/server/src/match/wsServer.ts` exports
 * `WS_PATH = "/ws/match"` and `attachWebSocketServer` leaves a handshake off that path alone, so
 * anything else is refused at the upgrade. It is spelled here rather than imported because
 * `support/` type-checks without `apps/*` being buildable (see e2e/tsconfig.json).
 */
export const server = {
  http: () => env("apiUrl", "http://localhost:8787"),
  ws: () => env("wsUrl", "ws://localhost:8787/ws/match"),
};

/**
 * A10: where the client reads its session from. `apps/web/src/net/session.ts` reads this key at
 * boot (`E2E_SESSION_STORAGE_KEY`) as well as the one a real sign-in writes, and the frozen specs
 * write it in `cy.visit`'s `onBeforeLoad` (`visitAs` in 05, 06, 09, 10) because spec 05 reloads
 * mid-match and the session has to survive it. `cy.signIn` / `cy.visitAs` write the same key, so
 * this is the one place to change it.
 */
export const SESSION_STORAGE_KEY = "jackioh.e2e.session";

/**
 * A17: where the deck workshop mirrors unsynced drafts on this device (R256): `mirrorKey` in
 * `apps/web/src/game/deckbuilder/sync.ts`, `jackioh.decks.v1.<profileId>`, holding
 * `{ v: 1, decks: [{ item, dirty }], trios: [{ item, dirty }], deletedDecks, deletedTrios }`. Spec 09
 * seeds it with drafts a save would refuse, which is the only way a browser meets L3 and L6; spec 18
 * reads nothing from it directly, only what the workshop restores. Spelled here, not imported,
 * because `support/` type-checks without `apps/*` (e2e/tsconfig.json).
 */
export function deckMirrorKey(profileId: string): string {
  return `jackioh.decks.v1.${profileId}`;
}

/**
 * SPEC §9.10, R294: where the tutorial keeps which lessons this device has completed, as
 * `{ v: TUTORIAL_PROGRESS_VERSION, completed: string[] }` (`TUTORIAL_PROGRESS_KEY` and
 * `TUTORIAL_PROGRESS_VERSION` in apps/web/src/tutorial/config.ts). Specs 22 and 23 seed it in
 * `onBeforeLoad` and read it back; this is the one place the suite spells it.
 */
export const TUTORIAL_PROGRESS_KEY = "jackioh.tutorial.v1";
export const TUTORIAL_PROGRESS_VERSION = 1;

/**
 * R290: the tutorial opponent's handicap, `AI_TUTORIAL` in packages/engine/src/config.ts. Spec 23
 * asserts a lesson's AI seat carries exactly this and that the engine's own constant still says
 * the same (read through `cy.task("tutorialLessons")`), so a change to the ruling fails here first.
 */
export const TUTORIAL_HANDICAP = {
  deckSize: 12,
  manaBonus: 0,
  manaCap: 3,
  extraOpeningCards: 0,
  extraDrawsPerTurn: 0,
  heroHealth: 20,
} as const;

/** A6: one fixture account. `token` is the ready-made access token `cy.signIn` installs. */
export type E2EAccount = { email: string; password: string; token: string };

/**
 * A6: fixture accounts the `E2E=1` server seeds (BUILD M8: "a test server with fixture accounts").
 * `pending` is the invite-gate account of spec 10; `p1`/`p2` are active and own every card.
 */
export const accounts: Record<"p1" | "p2" | "pending", () => E2EAccount> = {
  p1: () => ({ email: env("p1Email", "e2e-p1@jackioh.test"), password: env("p1Password", "e2e-p1-password"), token: env("p1Token", "e2e-token-p1") }),
  p2: () => ({ email: env("p2Email", "e2e-p2@jackioh.test"), password: env("p2Password", "e2e-p2-password"), token: env("p2Token", "e2e-token-p2") }),
  pending: () => ({ email: env("pendingEmail", "e2e-pending@jackioh.test"), password: env("pendingPassword", "e2e-pending-password"), token: env("pendingToken", "e2e-token-pending") }),
};

/** A6: invite codes the `E2E=1` server seeds, one per §9.4 failure mode plus one that works. */
export const inviteCodes = {
  good: () => env("goodCode", "ABCD-EFGH-JKMN-PQRS"),
  missing: () => env("missingCode", "ZZZZ-ZZZZ-ZZZZ-ZZZZ"),
  expired: () => env("expiredCode", "XPRD-XPRD-XPRD-XPRD"),
  exhausted: () => env("exhaustedCode", "XHST-XHST-XHST-XHST"),
};

/**
 * Waits. No spec ever calls `cy.wait(ms)` (BUILD M8); these are only assertion timeouts, which
 * Cypress retries against the DOM instead of sleeping.
 */
export const timeouts = {
  /**
   * One action's animations must have drained (`cy.settled()`), started (`cy.expectAnimating()`)
   * or closed their prompt (`cy.noPrompt()`).
   *
   * This covers a whole BURST, not one row. The slowest row in BUILD M5-T4 is `trapFired` at
   * 700 ms, but one action can hand the runner many entries at once, and `cy.settled()` waits for
   * all of them. The runner squeezes a long burst into `BURST_BUDGET_MS` (2.4 s) but never below
   * `MIN_ENTRY_MS` (120 ms) an entry (apps/web/src/game/animations.ts), and a view carries at most
   * `VIEW_EVENT_LIMIT` (32) events, one entry each at most, so one action can plan up to
   * 32 × 120 = 3.84 s before any timer slips. Spec 08 comes close: p2's mulligan answer lets R82
   * auto-end turns 1 to 4, 29 entries, and the burst measured 3.91–3.98 s in Chrome on the
   * integrated polish branch, both at full speed and under a 4x CPU throttle. The old 4 s left that
   * burst under 100 ms of slack, and PR #3's CI runs failed spec 08 there when a little extra
   * main-thread work landed inside it. 8 s (the `defaultCommandTimeout`) covers the longest burst a
   * view can plan with room for a slow runner. Waiting longer weakens no assertion: an animation
   * that never ends, or a prompt that never closes, still fails.
   */
  animation: 8_000,
  /** A view push from the server (M6-T4) or a seat handover. */
  view: 10_000,
  /** A whole seeded game to run out in spec 01 / 08. */
  game: 180_000,
  /** A `cy.task("wsPlayer", …)` round trip. */
  task: 20_000,
};

/** SPEC §2 / BUILD §2 constants the specs assert against. Kept here so no spec hard-codes them. */
export const constants = {
  DECK_SIZE: 20,
  MAX_COPIES: 1,
  MAX_MANA: 4,
  HERO_HEALTH: 30,
  TURN_CAP_PLAYER_TURNS: 30,
  HAND_CAP: 10,
  UNIT_ZONES: 5,
  BACKROW_ZONES: 5,
  OPENING_DRAW: [3, 4] as const,
  ROOM_CODE_LENGTH: 6,
  DECKS_PER_LOADOUT: 3,
  /** R80: a library holds at most this many cards (`LIBRARY_CAP`), so no handicap deck is larger. */
  LIBRARY_CAP: 60,
};

/**
 * R201: where the board keeps the viewer's effects settings, `{ speed, intensity, motion }`
 * (`FX_SETTINGS_KEY` in apps/web/src/fx/constants.ts, read by `fx/settings.ts`). Speed divides every
 * animation's duration and is clamped to 0.5..2, so 0.5 plays everything at half speed. Spec 25's
 * screenshot pass writes it in `onBeforeLoad` so a notice is still up when the shot is taken.
 * Spelled here, not imported, because `support/` type-checks without `apps/*`.
 */
export const FX_SETTINGS_KEY = "jackioh.fx.v1";
