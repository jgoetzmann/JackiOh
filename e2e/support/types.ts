// Types the specs and the support commands share.
//
// e2e does NOT import @jackioh/shared: BUILD M8 is written while packages/* and apps/* are still
// in flight, and `tsc -p e2e/tsconfig.json` has to pass on its own. Everything below is a
// structural subset of the real types (SPEC §10.1, §10.2, §10.8) — narrow enough that a drift in
// the engine types cannot silently break the specs, wide enough for the assertions M8 asks for.

/** SPEC §10.1: seats. */
export type PlayerId = "p1" | "p2";

/** BUILD M5-T1 testid: `zone-<side>-<row>-<lane>`. `side` is view-relative (ASSUMPTION A3). */
export type Side = "you" | "opponent";

/** SPEC §3: the two field rows. */
export type Row = "units" | "backrow";

/** SPEC §3.1: lanes are 1-indexed, 1..5, exactly as `packages/engine/src/zones.ts` numbers them. */
export type Lane = 1 | 2 | 3 | 4 | 5;

export type ZoneRef = { side: Side; row: Row; lane: Lane };

/** SPEC §10.6 / packages/shared/src/catalog-types.ts. */
export type PromptKind =
  | "discover"
  | "target"
  | "mode"
  | "mulligan"
  | "hand"
  | "zone"
  | "tribute"
  | "direction"
  | "x"
  | "embiggen";

/** BUILD M5-T4: every animation sets `data-animating="<eventType>"` while it runs. */
export type EventType = string;

/** packages/shared/src/actions.ts `Selection`. */
export type Selection =
  | { pick: "instance"; instanceId: string }
  | { pick: "hero"; player: PlayerId }
  | { pick: "zone"; player: PlayerId; row: Row; lane: number }
  | { pick: "mode"; option: string }
  | { pick: "none" };

/** packages/shared/src/actions.ts `ActionBody`, client-sendable members only. */
export type ActionBody =
  | { type: "mulligan"; keep: string[] }
  | {
      type: "play";
      instanceId: string;
      zone?: { row: Row; lane: number };
      x?: number;
      embiggen?: boolean;
      tributes?: string[];
      targets?: Selection[];
      modes?: string[];
    }
  | { type: "attack"; attackerId: string; targetId: string }
  | { type: "switchPosition"; instanceId: string }
  | { type: "activatePower"; instanceId: string; targets?: Selection[] }
  | { type: "answer"; choiceId: string; selection: Selection[] }
  | { type: "offerDraw" }
  | { type: "answerDraw"; accept: boolean }
  | { type: "concede" }
  | { type: "endTurn" };

export type ActionInput = ActionBody & { playerId: PlayerId };
export type Action = ActionBody & { playerId: PlayerId; nonce: string };

/**
 * The parts of `GameState` (SPEC §10.1) the specs read off `window.__jackioh.state`.
 * Deliberately loose: the specs assert through `viewFor`-shaped data and the DOM, and use the
 * state only for the replay hash (spec 01) and for seat/turn bookkeeping.
 */
export type GameStateLike = {
  seed: string;
  turn: number;
  active: PlayerId;
  phase: string;
  result: { winner: PlayerId | "draw"; reason: string } | null;
  /**
   * TWO SHAPES, ONE FIELD. The hotseat handle hands over the raw `GameState`, so `pending` is the
   * engine's `PendingChoice` and the seat it belongs to is **`playerId`**
   * (`packages/engine/src/state.ts`). A networked handle has no `GameState` at all and derives this
   * from the `PlayerView` instead (`apps/web/src/game/net.ts` `viewDerivedState`), which spells the
   * same seat **`player`**. Both are optional here because either may be the one present.
   *
   * Declaring only `player` is what made an assertion on a hotseat game read `undefined` and pass
   * type-checking while failing at run time, so both names are spelled out rather than one.
   */
  pending:
    | { id?: string; choiceId?: string; kind?: PromptKind; playerId?: PlayerId; player?: PlayerId }
    | null;
  /**
   * §2.1 step 3, R265: both seats' opening mulligans while they are open at once — hotseat only,
   * since it is the raw `GameState` (`packages/engine/src/state.ts` `MulliganSeat`). `pending` is
   * null for the whole window; `keep` is a seat's sealed answer, null until it gives one. Absent
   * once the second answer has resolved both, and never on a networked handle.
   */
  mulligan?: Record<PlayerId, { prompt?: { id?: string; kind?: PromptKind }; keep: string[] | null }>;
  players: Record<PlayerId, unknown>;
  [key: string]: unknown;
};

/**
 * BUILD M5-T3: `/dev/hotseat` exposes this when `import.meta.env.MODE !== "production"`.
 * `state`, `dispatch` and `seed` are the fixed contract. `log` and `decks` are ASSUMPTION A2 and
 * are only needed by spec 01 (recorded-log replay hash).
 */
export type JackiOhDevHandle = {
  state: GameStateLike;
  dispatch: (action: ActionInput) => void;
  seed: string;
  /** ASSUMPTION A2: every action the hotseat loop has reduced, in order, with its nonce. */
  log?: Action[];
  /** ASSUMPTION A2: the two deck lists the route resolved, seat order [p1, p2]. */
  decks?: [string[], string[]];
  /** Present in networked mode (apps/web/src/game/net.ts) when the route is not hotseat. */
  seat?: PlayerId;
};

/** A scenario deck under e2e/fixtures/decks. Shape is ASSUMPTION A1. */
export type FixtureDeck = {
  /** The id passed as `a=` / `b=` on the hotseat route. Equals the filename without `.json`. */
  id: string;
  /** Which M8 spec owns this fixture. */
  spec: string;
  /** Why these cards: what the spec needs out of the deck. */
  description: string;
  /** Exactly DECK_SIZE (20) distinct non-Token catalog ids; `validateDeck` throws otherwise. */
  cards: string[];
};

/** What `seedGame` injects for the client to resolve `a=` / `b=` (ASSUMPTION A1). */
export type E2EDeckInjection = {
  decks: Record<string, string[]>;
  seed: string;
};

/** How a prompt is answered. `answerPrompt` resolves these against the modal, then the board. */
export type PromptAnswer = {
  /** `PendingOption.key` values to pick (discover, mode, direction, embiggen, hand, mulligan). */
  options?: string[];
  /**
   * Take the first N options offered, whatever their keys are. Discover's three options are drawn
   * by the match rng (SPEC §10.6), so no spec can name one: "take the first" is the only stable
   * way to answer it. Picked before `options`, and the two can be combined.
   */
  first?: number;
  /**
   * R81's embiggen price, as the boolean it is. The picker keys its two options `"true"` and
   * `"false"` (the two prices), so this is `options: [String(embiggen)]` without a spec having to
   * know that the key is a stringified boolean.
   */
  embiggen?: boolean;
  /** Board instance ids to pick (target, tribute, hand pickers rendered on the cards). */
  cards?: string[];
  /** Board zones to pick (zone pickers). */
  zones?: ZoneRef[];
  /** A hero target (`target` prompts that may hit a hero). */
  hero?: Side;
  /** The value for an `x` prompt. */
  x?: number;
  /** Press submit even for a single-pick kind (multi-select kinds always submit). */
  submit?: boolean;
};

declare global {
  interface Window {
    /** BUILD M5-T3. */
    __jackioh?: JackiOhDevHandle;
    /** ASSUMPTION A1: fixture decks handed to the E2E build of the hotseat route. */
    __jackiohE2E?: E2EDeckInjection;
  }
}
