// `/dev/hotseat` (BUILD M5-T3), the route the twelve Cypress specs drive.
//
// `apps/web/src/game/hotseat.test.ts` covers the SESSION — nonces, the log, the seat, the
// subscription — against a scripted port. This file covers the ROUTE, which is everything the
// session is not: the URL parameters, the deck injection Cypress parks in `localStorage`, the
// seat-switch button, the seat that follows a prompt into the browser's DOM, the two failure
// panels, and `window.__jackioh`.
//
// The load-bearing test is the last pair. Every spec reaches the game through `cy.jackioh()`, so
// the handle's presence outside a production build and its ABSENCE inside one is the difference
// between twelve green specs and twelve specs that fail on their first command. BUILD M5-T3 states
// it as a condition on `import.meta.env.MODE`, and `apps/web/package.json` builds the e2e bundle
// with `--mode development` because of it, so `MODE` is what this file manipulates.
//
// Nothing here is a rule (CLAUDE.md rule 7): the port is a fake, and what is asserted is what the
// route asked it for and what it drew from the `PlayerView` it got back.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { Action, CardDef, CardDefs, PlayerId, PlayerView } from "@jackioh/shared";

import { testid } from "../../game/contract.ts";
import { setEnginePort } from "../../game/engine.ts";
import type { CreateGameArgs, EnginePort, EngineState } from "../../game/engine.ts";
import { baseView, emptySide } from "../../test/fixtures.ts";
import { DEFAULT_SEED, E2E_DECKS_KEY, HotseatRoute, readInjectedDecks, readParams } from "./hotseat.tsx";

/* ------------------------------------------------------------------------------------------- *
 * a fake engine and a fake catalog
 * ------------------------------------------------------------------------------------------- */

type FakeState = { turn: number; active: PlayerId; pendingFor: PlayerId | null };

type Fake = {
  port: EnginePort;
  createGameArgs: CreateGameArgs[];
  /** Every action the route handed to `reduce`. */
  actions: Action[];
  viewedBy: PlayerId[];
  /** Whose prompt the NEXT accepted `reduce` leaves open. Consumed once. */
  pendingAfterNext: PlayerId | null;
  /** Whose prompt is open the moment the game begins (the §2.1 mulligan belongs to one seat). */
  pendingAfterBegin: PlayerId | null;
};

function def(index: number, over: Partial<CardDef> = {}): CardDef {
  return {
    id: `core-${String(index).padStart(3, "0")}`,
    index: String(index),
    name: `Card ${index}`,
    set: "Core",
    type: "Unit",
    tags: [],
    rarity: "Common",
    token: false,
    // Not monotonic in the index, so `first20` and `cheap20` resolve to DIFFERENT lists and a
    // route that read `?a=` twice could not pass.
    cost: (index * 3) % 7,
    base: { attack: 1, health: 1, keywords: [], text: "" },
    radiant: { attack: 2, health: 2, keywords: [], text: "" },
    ...over,
  };
}

function catalogOf25(): CardDefs {
  const defs: CardDef[] = [];
  for (let i = 1; i <= 25; i += 1) defs.push(def(i));
  return Object.fromEntries(defs.map((d) => [d.id, d]));
}

function makeEngine(options: { catalog?: CardDefs | "throws"; pendingAfterBegin?: PlayerId | null } = {}): Fake {
  const fake: Fake = {
    port: undefined as unknown as EnginePort,
    createGameArgs: [],
    actions: [],
    viewedBy: [],
    pendingAfterNext: null,
    pendingAfterBegin: options.pendingAfterBegin ?? null,
  };

  let live: FakeState = { turn: 0, active: "p1", pendingFor: null };
  const unwrap = (state: EngineState): FakeState => state as unknown as FakeState;
  const wrap = (state: FakeState): EngineState => state as unknown as EngineState;
  const catalog = options.catalog ?? catalogOf25();

  fake.port = {
    createGame: (args) => {
      fake.createGameArgs.push(args);
      live = { turn: 0, active: "p1", pendingFor: null };
      return wrap(live);
    },
    beginGame: (state) => {
      live = { ...unwrap(state), turn: 1, pendingFor: fake.pendingAfterBegin };
      return { state: wrap(live), events: [] };
    },
    reduce: (state, action) => {
      fake.actions.push(action);
      live = { ...unwrap(state), turn: unwrap(state).turn + 1, pendingFor: fake.pendingAfterNext };
      fake.pendingAfterNext = null;
      return { state: wrap(live), events: [] };
    },
    legalActions: () => [],
    viewFor: (state, player) => {
      fake.viewedBy.push(player);
      const held = unwrap(state);
      const other: PlayerId = player === "p1" ? "p2" : "p1";
      const view: PlayerView = baseView({
        viewer: player,
        turn: held.turn,
        active: held.active,
        you: emptySide(player),
        opponent: emptySide(other, { hand: { count: 0 } }),
        pending:
          held.pendingFor === null
            ? null
            : held.pendingFor === player
              ? { forYou: true, choiceId: "ch1", kind: "target", options: [], min: 1, max: 1, prompt: "Choose" }
              : { forYou: false, pendingFor: held.pendingFor },
      });
      return view;
    },
    hashState: (state) => `hash:${unwrap(state).turn}`,
    catalog:
      catalog === "throws"
        ? () => {
            throw new Error("no catalog is registered");
          }
        : () => catalog,
  };

  return fake;
}

/* ------------------------------------------------------------------------------------------- *
 * mounting
 * ------------------------------------------------------------------------------------------- */

function at(search: string): void {
  window.history.replaceState({}, "", `/dev/hotseat${search}`);
}

/** Render the route and wait for the engine promise the route resolves in an effect. */
async function mount(search = "?seed=42&a=first20&b=cheap20"): Promise<void> {
  at(search);
  await act(async () => {
    render(<HotseatRoute />);
  });
}

afterEach(() => {
  // `globals: false`, so @testing-library/react registers no cleanup of its own.
  cleanup();
  setEnginePort(null);
  delete window.__jackioh;
  delete window.__jackiohE2E;
  window.localStorage.clear();
  at("");
  vi.unstubAllEnvs();
  vi.resetModules();
});

/* ------------------------------------------------------------------------------------------- *
 * the URL
 * ------------------------------------------------------------------------------------------- */

describe("readParams", () => {
  it("reads ?seed=&a=&b= as BUILD M5-T3 writes them", () => {
    expect(readParams("?seed=42&a=first20&b=cheap20")).toEqual({ seed: "42", a: "first20", b: "cheap20" });
  });

  it("falls back to seed 42 and the default deck for a missing or empty parameter", () => {
    expect(readParams("")).toEqual({ seed: DEFAULT_SEED, a: "first20", b: "first20" });
    expect(readParams("?seed=&a=&b=")).toEqual({ seed: DEFAULT_SEED, a: "first20", b: "first20" });
    expect(readParams("?seed=7")).toEqual({ seed: "7", a: "first20", b: "first20" });
  });
});

describe("readInjectedDecks (ASSUMPTION A1: cy.seedGame's fixture decks)", () => {
  it("reads the window handle, then the localStorage copy that survives a reload", () => {
    window.__jackiohE2E = { decks: { fixture: ["core-001", "core-002"] } };
    expect(readInjectedDecks()).toEqual({ fixture: ["core-001", "core-002"] });

    delete window.__jackiohE2E;
    window.localStorage.setItem(E2E_DECKS_KEY, JSON.stringify({ decks: { stored: ["core-003"] } }));
    expect(readInjectedDecks()).toEqual({ stored: ["core-003"] });
  });

  it("is undefined with no injection, and drops anything that is not a list of card ids", () => {
    expect(readInjectedDecks()).toBeUndefined();

    window.localStorage.setItem(E2E_DECKS_KEY, "not json");
    expect(readInjectedDecks()).toBeUndefined();

    window.__jackiohE2E = { decks: { good: ["core-001"], notAList: "core-002", notStrings: [1, 2] } } as never;
    expect(readInjectedDecks()).toEqual({ good: ["core-001"] });
  });
});

/* ------------------------------------------------------------------------------------------- *
 * starting the game
 * ------------------------------------------------------------------------------------------- */

describe("the route starts one game from the URL", () => {
  it("hands the engine the seed and the two decks the a= and b= ids resolve to", async () => {
    const fake = makeEngine();
    setEnginePort(fake.port);
    await mount("?seed=seed-7&a=first20&b=cheap20");

    expect(fake.createGameArgs).toHaveLength(1);
    const args = fake.createGameArgs[0];
    expect(args?.seed).toBe("seed-7");
    expect(args?.decks[0]).toHaveLength(20);
    expect(args?.decks[1]).toHaveLength(20);
    // Two different deck ids resolve to two different libraries: `b=` is read as itself.
    expect(args?.decks[0]).not.toEqual(args?.decks[1]);
    expect(args?.decks[0]?.[0]).toBe("core-001");
    // The catalog the port registered is the one the game is created with (no second source).
    expect(args?.catalog).toBe(fake.port.catalog?.());

    // The bar names the seed and the seat the device is on, and the board is drawn.
    const bar = document.querySelector(".hotseat-bar");
    expect(bar?.textContent).toContain("seed-7");
    expect(bar?.textContent).toContain("p1");
    expect(screen.getByTestId(testid.board)).toBeInTheDocument();
  });

  it("plays the injected fixture decks Cypress parked in localStorage", async () => {
    window.localStorage.setItem(
      E2E_DECKS_KEY,
      JSON.stringify({ decks: { fixture: Array.from({ length: 20 }, (_, i) => `core-${String(i + 1).padStart(3, "0")}`) } }),
    );
    const fake = makeEngine();
    setEnginePort(fake.port);
    await mount("?seed=42&a=fixture&b=fixture");

    expect(fake.createGameArgs[0]?.decks[0]?.[19]).toBe("core-020");
  });

  it("renders the engine's own refusal instead of a game when a deck id is unknown", async () => {
    const fake = makeEngine();
    setEnginePort(fake.port);
    await mount("?seed=42&a=aggro-please&b=first20");

    expect(screen.queryByTestId(testid.board)).toBeNull();
    expect(screen.getByText(/unknown deck "aggro-please"/)).toBeInTheDocument();
    expect(fake.createGameArgs).toHaveLength(0);
  });

  it("renders the missing exports when the engine cannot be loaded, and draws no board", async () => {
    // The route refuses to invent a `viewFor` of its own (CLAUDE.md rule 7, SPEC §10.8), so an
    // engine it cannot load is a panel, not a stubbed game. `loadEnginePort` only rejects when the
    // real dynamic import fails, which no injected port can simulate — hence the module mock and
    // the re-import, the same lever the production-build test below uses.
    vi.resetModules();
    vi.doMock("../../game/engine.ts", async () => {
      const actual = await vi.importActual<typeof import("../../game/engine.ts")>("../../game/engine.ts");
      return {
        ...actual,
        loadEnginePort: () => Promise.reject(new actual.EngineUnavailableError(["viewFor", "hashState"])),
      };
    });

    try {
      const route = await import("./hotseat.tsx");
      at("?seed=42&a=first20&b=first20");
      await act(async () => {
        render(<route.HotseatRoute />);
      });

      expect(screen.queryByTestId(testid.board)).toBeNull();
      // Both halves of the panel: the missing exports, and the engine's own message.
      expect(screen.getAllByText(/viewFor, hashState/).length).toBeGreaterThan(0);
      expect(screen.getByText(/waiting on M3/)).toBeInTheDocument();
    } finally {
      vi.doUnmock("../../game/engine.ts");
      vi.resetModules();
    }
  });
});

/* ------------------------------------------------------------------------------------------- *
 * the seat
 * ------------------------------------------------------------------------------------------- */

describe("the seat", () => {
  it("hands the device over on the button, and re-renders viewFor for the other player", async () => {
    const fake = makeEngine();
    setEnginePort(fake.port);
    await mount();

    expect(screen.getByTestId(testid.seatSwitch)).toHaveTextContent("Hand over to p2");
    fake.viewedBy.length = 0;

    await act(async () => {
      fireEvent.click(screen.getByTestId(testid.seatSwitch));
    });

    expect(fake.viewedBy).toContain("p2");
    expect(fake.viewedBy).not.toContain("p1");
    expect(screen.getByTestId(testid.seatSwitch)).toHaveTextContent("Hand over to p1");
    expect(window.__jackioh?.seat).toBe("p2");
  });

  it("switches seats by itself when a prompt belongs to the other player", async () => {
    const fake = makeEngine();
    setEnginePort(fake.port);
    await mount();
    expect(window.__jackioh?.seat).toBe("p1");

    // The engine answers the next action with a prompt for p2. Nobody presses the button.
    fake.pendingAfterNext = "p2";
    await act(async () => {
      window.__jackioh?.dispatch({ type: "endTurn" });
    });

    expect(window.__jackioh?.seat).toBe("p2");
    expect(window.__jackioh?.view().viewer).toBe("p2");
    expect(window.__jackioh?.view().pending).toMatchObject({ forYou: true });
    await waitFor(() => {
      expect(screen.getByTestId(testid.seatSwitch)).toHaveTextContent("Hand over to p1");
    });
  });

  it("follows the opening prompt before the first render (§2.1 mulligan)", async () => {
    const fake = makeEngine({ pendingAfterBegin: "p2" });
    setEnginePort(fake.port);
    await mount();

    expect(window.__jackioh?.seat).toBe("p2");
    expect(screen.getByTestId(testid.seatSwitch)).toHaveTextContent("Hand over to p1");
  });
});

/* ------------------------------------------------------------------------------------------- *
 * window.__jackioh — what all twelve specs reach through
 * ------------------------------------------------------------------------------------------- */

describe("window.__jackioh outside a production build", () => {
  it("publishes { state, dispatch, seed } plus what Cypress drives two seats with", async () => {
    const fake = makeEngine();
    setEnginePort(fake.port);
    await mount("?seed=42&a=first20&b=cheap20");

    const handle = window.__jackioh;
    expect(handle, "BUILD M5-T3: the dev handle is what every e2e spec reaches through").toBeDefined();
    if (handle === undefined) return;

    expect(handle.seed).toBe("42");
    expect(handle.seat).toBe("p1");
    expect(handle.log).toEqual([]);
    expect(handle.decks[0]).toHaveLength(20);
    expect(handle.view().viewer).toBe("p1");
    expect(handle.legal()).toEqual([]);
    expect(typeof handle.hash()).toBe("string");
    expect(handle.state).toBeDefined();
  });

  it("exposes getters, so a spec that re-reads the handle sees the current game", async () => {
    const fake = makeEngine();
    setEnginePort(fake.port);
    await mount();
    const handle = window.__jackioh;
    const before = handle?.hash();

    await act(async () => {
      handle?.dispatch({ type: "endTurn" });
    });

    // The same handle object, not a re-read of `window.__jackioh`: the fields are getters.
    expect(handle?.hash()).not.toBe(before);
    expect(handle?.log.map((action) => action.nonce)).toEqual(["n0"]);
    expect(handle?.log.map((action) => action.type)).toEqual(["endTurn"]);
    expect(fake.actions).toHaveLength(1);
  });

  it("dispatching as the other seat switches the device first, never forging the action", async () => {
    const fake = makeEngine();
    setEnginePort(fake.port);
    await mount();

    await act(async () => {
      window.__jackioh?.dispatch({ type: "endTurn", playerId: "p2" });
    });

    expect(window.__jackioh?.seat).toBe("p2");
    // `createHotseat` stamps the action with the seat it switched to — p2 acts as p2.
    expect(fake.actions.map((action) => action.playerId)).toEqual(["p2"]);
  });

  it("is removed when the route unmounts, so a stale handle cannot answer a later spec", async () => {
    const fake = makeEngine();
    setEnginePort(fake.port);
    at("?seed=42&a=first20&b=first20");
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<HotseatRoute />);
    });
    expect(window.__jackioh).toBeDefined();

    await act(async () => {
      view.unmount();
    });
    expect(window.__jackioh).toBeUndefined();
  });
});

describe("window.__jackioh in a production build", () => {
  /**
   * The defect this test exists for: a production bundle that still published the handle, or a
   * development bundle that did not. `apps/web/package.json` builds the e2e client with
   * `vite build --mode development` for exactly this reason, and `main.tsx` serves NotFound for
   * `/dev/hotseat` under the same condition. Here `MODE` is stubbed and the module re-imported, so
   * the module-level `DEV_ONLY` is evaluated again.
   */
  it("publishes nothing: MODE=production removes the handle the twelve specs drive", async () => {
    vi.stubEnv("MODE", "production");
    vi.resetModules();

    const engine = await import("../../game/engine.ts");
    const route = await import("./hotseat.tsx");
    expect(import.meta.env.MODE, "vi.stubEnv must reach import.meta.env, or this proves nothing").toBe(
      "production",
    );

    const fake = makeEngine();
    engine.setEnginePort(fake.port);
    at("?seed=42&a=first20&b=first20");
    await act(async () => {
      render(<route.HotseatRoute />);
    });

    // The game still runs — the route is not disabled, only the dev handle is withheld.
    expect(screen.getByTestId(testid.board)).toBeInTheDocument();
    expect(window.__jackioh).toBeUndefined();
    // And the E2E deck injection is withheld with it.
    window.__jackiohE2E = { decks: { fixture: ["core-001"] } };
    expect(route.readInjectedDecks()).toBeUndefined();

    engine.setEnginePort(null);
  });
});
