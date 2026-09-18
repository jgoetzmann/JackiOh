// Routes, endpoints and fixture accounts the suite talks to. Everything is overridable from the
// Cypress env so the web/server teams can move a route without editing twelve specs:
//
//   pnpm --dir e2e test:e2e --expose wsUrl=ws://127.0.0.1:8787/match
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
};

/** A6: the `E2E=1` server the networked specs (05, 06, 07, 10) talk to. */
export const server = {
  http: () => env("apiUrl", "http://localhost:8787"),
  ws: () => env("wsUrl", "ws://localhost:8787/match"),
};

/**
 * A6: fixture accounts the `E2E=1` server seeds (BUILD M8: "a test server with fixture accounts").
 * `pending` is the invite-gate account of spec 10; `p1`/`p2` are active and own every card.
 */
export const accounts = {
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
  /** An animation must have drained. The slowest row in BUILD M5-T4 is `trapFired` at 700 ms. */
  animation: 4_000,
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
};
