// `/practice`: B32 and B33 of docs/polish/3-ai.md, in jsdom.
//
// The route is rendered with every seam injected — the account, the loadout reader, the host that
// would otherwise start a worker, and the e2e pacing — so nothing here needs a server, a session,
// a worker or the engine. The host is a scripted fake that answers `start` with a fixture view for
// whichever seat the route asked to play, which is what lets these tests read the seat, the
// difficulty and the deck the route chose straight off the request it sent.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { opponentOf } from "@jackioh/shared";
import type { CardDefs, PlayerId } from "@jackioh/shared";

import type { LoadoutResponse } from "../net/api.ts";
import type { Account } from "../net/gate.ts";
import {
  PRACTICE_PACING,
  PRACTICE_PACING_FAST,
  PRACTICE_PACING_REDUCED,
  PRACTICE_SETUP_KEY,
  PRACTICE_VOICE_HOLD_MAX_MS,
  type PracticePacing,
} from "../practice/config.ts";
import { PRACTICE_PRESETS, deckChoiceFromValue, deckChoiceValue } from "../practice/decks.ts";
import type { PracticeHost } from "../practice/host.ts";
import type {
  PracticeDebug,
  PracticeRequestBody,
  PracticeResponse,
  PracticeSnapshot,
  PracticeStartConfig,
} from "../practice/protocol.ts";
import { practiceTestid } from "../practice/testids.ts";
import { baseView, emptySide } from "../test/fixtures.ts";
import { setReducedMotion } from "../test/setup.ts";
import PracticeRoute, { readPracticeParams } from "./practice.tsx";
import type { PracticeRouteProps } from "./practice.tsx";

/** The Surface's testids, spelled out: e2e/support/testids.ts mirrors these exact strings. */
const T = {
  setup: "practice-setup",
  easy: "practice-difficulty-easy",
  medium: "practice-difficulty-medium",
  hard: "practice-difficulty-hard",
  deck: "practice-deck",
  start: "practice-start",
  loading: "practice-loading",
  error: "practice-error",
  hud: "practice-hud",
  thinking: "practice-thinking",
  newGame: "practice-new-game",
  leave: "practice-leave",
  leaveConfirm: "practice-leave-confirm",
  leaveStay: "practice-leave-stay",
  result: "practice-result",
  playAgain: "practice-play-again",
  changeSetup: "practice-change-setup",
  viewBoard: "practice-view-board",
  outcome: "practice-outcome",
  deckHint: "practice-deck-hint",
  deckPreview: "practice-deck-preview",
  deckCurve: "practice-deck-curve",
  menu: "practice-menu",
} as const;

const PRESET_VALUES = PRACTICE_PRESETS.map((preset) => `preset:${preset.id}`);

const SAVED_DECKS: string[][] = [
  Array.from({ length: 20 }, (_, i) => `core-${String(i + 1).padStart(3, "0")}`),
  Array.from({ length: 20 }, (_, i) => `core-${String(i + 21).padStart(3, "0")}`),
  Array.from({ length: 20 }, (_, i) => `core-${String(i + 41).padStart(3, "0")}`),
];

// ---------------------------------------------------------------------------------------------
// accounts and loadouts
// ---------------------------------------------------------------------------------------------

const ANONYMOUS: Account = { kind: "anonymous" };

function signedIn(status: "active" | "pending" | "banned"): Account {
  return {
    kind: "ready",
    token: "tok-1",
    me: {
      profile: { id: "u1", status, rating: 1000 },
      needsInviteCode: status === "pending",
      emailVerified: true,
      currentMatchId: null,
      email: "player@example.com",
    },
  };
}

function loadout(decks: string[][] | null): LoadoutResponse {
  return { catalogVersion: "v1", loadout: decks === null ? null : { catalogVersion: "v1", decks, updatedAt: 0 } };
}

// ---------------------------------------------------------------------------------------------
// the scripted host
// ---------------------------------------------------------------------------------------------

type HostOptions = {
  /** How `start` is answered: at once, with `failed`, or held until `releaseStart()`. */
  start?: "started" | "failed" | "hold";
  failure?: string;
  /** The started snapshot's `aiToAct`. */
  aiToAct?: boolean;
  /** Hold every `aiStep` until `releaseAiStep()`. */
  holdAiSteps?: boolean;
  /** How the setup's `catalog` request is answered: with FAKE_DEFS (the default) or `failed`. */
  catalog?: "answer" | "fail";
};

/**
 * The catalog the fake host answers `catalog` with: every preset's and saved deck's card, named
 * after its id and costing its id's last digit (so `core-014` costs 4 and `core-100` costs 0).
 */
const FAKE_DEFS: CardDefs = Object.fromEntries(
  [...new Set([...PRACTICE_PRESETS.flatMap((preset) => preset.cards), ...SAVED_DECKS.flat()])].map((id) => [
    id,
    {
      id,
      index: id.slice(5),
      name: `Card ${id}`,
      set: "Core",
      type: "Unit",
      tags: [],
      rarity: "Common",
      token: false,
      cost: Number(id.slice(-1)),
      base: { attack: 1, health: 1, keywords: [], text: "" },
      radiant: { attack: 2, health: 2, keywords: [], text: "" },
    } as unknown as CardDefs[string],
  ]),
);

type RouteHost = {
  factory: Mock<() => PracticeHost>;
  requests: PracticeRequestBody[];
  starts(): PracticeStartConfig[];
  disposals(): number;
  releaseStart(): void;
  releaseAiStep(aiToAct: boolean): void;
  debug: PracticeDebug;
};

function snapshotFor(human: PlayerId, aiToAct: boolean): PracticeSnapshot {
  const ai = opponentOf(human);
  return {
    view: baseView({
      viewer: human,
      turn: 1,
      active: aiToAct ? ai : human,
      phase: "main",
      you: emptySide(human),
      opponent: emptySide(ai, { hand: { count: 4 } }),
    }),
    legal: aiToAct ? [] : [{ type: "endTurn" }, { type: "concede" }],
    aiToAct,
    error: null,
  };
}

/** The game after the human concedes: the AI has won (§2.5). */
function concededSnapshot(human: PlayerId): PracticeSnapshot {
  const base = snapshotFor(human, false);
  return { ...base, view: { ...base.view, result: { winner: opponentOf(human), reason: "concede" } }, legal: [] };
}

function routeHost(options: HostOptions = {}): RouteHost {
  const requests: PracticeRequestBody[] = [];
  let id = 0;
  let human: PlayerId = "p1";
  let disposals = 0;
  let heldStart: (() => void) | null = null;
  const heldSteps: ((aiToAct: boolean) => void)[] = [];
  const debug: PracticeDebug = {
    seed: "fake-seed",
    decks: [[], []],
    handicaps: {},
    log: [],
    state: { fake: true },
    hash: "0badc0de",
    difficulty: "easy",
    humanSeat: "p1",
  };

  const host: PracticeHost = {
    request(body) {
      requests.push(body);
      id += 1;
      const mine = id;
      if (body.type === "start") {
        human = body.config.humanSeat;
        if (options.start === "failed") {
          return Promise.resolve({ id: mine, type: "failed", message: options.failure ?? "the core refused" });
        }
        const started: PracticeResponse = {
          id: mine,
          type: "started",
          snapshot: snapshotFor(human, options.aiToAct ?? false),
          defs: {},
          aiSeat: opponentOf(human),
        };
        if (options.start === "hold") {
          return new Promise<PracticeResponse>((resolve) => {
            heldStart = () => resolve(started);
          });
        }
        return Promise.resolve(started);
      }
      if (body.type === "aiStep" && options.holdAiSteps === true) {
        return new Promise<PracticeResponse>((resolve) => {
          heldSteps.push((aiToAct) => resolve({ id: mine, type: "snapshot", snapshot: snapshotFor(human, aiToAct) }));
        });
      }
      if (body.type === "debug") return Promise.resolve({ id: mine, type: "debug", debug });
      if (body.type === "catalog") {
        return Promise.resolve(
          options.catalog === "fail"
            ? { id: mine, type: "failed", message: "the worker could not load the cards" }
            : { id: mine, type: "catalog", defs: FAKE_DEFS },
        );
      }
      if (body.type === "act" && body.action.type === "concede") {
        return Promise.resolve({ id: mine, type: "snapshot", snapshot: concededSnapshot(human) });
      }
      return Promise.resolve({ id: mine, type: "snapshot", snapshot: snapshotFor(human, false) });
    },
    dispose() {
      disposals += 1;
    },
  };

  return {
    factory: vi.fn(() => host),
    requests,
    starts: () =>
      requests.flatMap((body) => (body.type === "start" ? [body.config] : [])),
    disposals: () => disposals,
    releaseStart: () => {
      if (heldStart === null) throw new Error("no start is being held");
      heldStart();
    },
    releaseAiStep: (aiToAct) => {
      const next = heldSteps.shift();
      if (next === undefined) throw new Error("no aiStep is being held");
      next(aiToAct);
    },
    debug,
  };
}

// ---------------------------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------------------------

function renderRoute(
  host: RouteHost,
  props: Partial<PracticeRouteProps> = {},
): ReturnType<typeof render> {
  return render(
    <PracticeRoute
      hostFactory={host.factory}
      pacing={PRACTICE_PACING_FAST}
      account={ANONYMOUS}
      loadLoadout={vi.fn(() => Promise.reject(new Error("an anonymous page has no loadout")))}
      {...props}
    />,
  );
}

function visit(search: string): void {
  window.history.replaceState(null, "", `/practice${search}`);
}

function deckOptions(): string[] {
  const select = screen.getByTestId(T.deck) as HTMLSelectElement;
  return Array.from(select.options).map((option) => option.value);
}

function savedOptions(): string[] {
  return deckOptions().filter((value) => value.startsWith("saved:"));
}

/** Let the route's effects and the fake host's promises run. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

let fetchSpy: Mock<() => Promise<never>>;
let socketSpy: Mock<(url: string) => void>;

beforeEach(() => {
  visit("");
  try {
    window.localStorage.clear();
  } catch {
    // A storage that refuses is one of the cases under test; nothing to clear.
  }
  fetchSpy = vi.fn<() => Promise<never>>(() => Promise.reject(new Error("practice needs no server")));
  vi.stubGlobal("fetch", fetchSpy);
  socketSpy = vi.fn<(url: string) => void>();
  vi.stubGlobal(
    "WebSocket",
    class {
      constructor(url: string) {
        socketSpy(url);
      }
    },
  );
});

afterEach(() => {
  cleanup();
  document.body.removeAttribute("data-speaking");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete window.__jackiohPractice;
  try {
    window.localStorage.clear();
  } catch {
    // see beforeEach
  }
  window.history.replaceState(null, "", "/");
});

// ---------------------------------------------------------------------------------------------
// B32: setup, for anyone
// ---------------------------------------------------------------------------------------------

describe("B32 /practice shows setup to anyone", () => {
  it("B32 renders with no account, session or server: three difficulty radios on easy and random plus every preset", async () => {
    const host = routeHost();
    const loadLoadout = vi.fn(() => Promise.resolve(loadout(SAVED_DECKS)));
    renderRoute(host, { loadLoadout });
    await settle();

    expect(screen.getByTestId(T.setup)).toBeInTheDocument();
    for (const id of [T.easy, T.medium, T.hard]) {
      expect(screen.getByTestId(id)).toHaveAttribute("type", "radio");
    }
    expect(screen.getByTestId(T.easy)).toBeChecked();
    expect(screen.getByTestId(T.medium)).not.toBeChecked();
    expect(screen.getByTestId(T.hard)).not.toBeChecked();

    expect(screen.getByTestId(T.deck).tagName).toBe("SELECT");
    expect([...deckOptions()].sort()).toEqual(["random", ...PRESET_VALUES].sort());
    expect(savedOptions()).toEqual([]);

    expect(loadLoadout).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(socketSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId(T.hud)).toBeNull();
    expect(screen.queryByTestId("game")).toBeNull();
  });

  it("B32 the initial difficulty and deck come from jackioh.practice.setup", async () => {
    window.localStorage.setItem(PRACTICE_SETUP_KEY, JSON.stringify({ difficulty: "hard", deck: "preset:humans" }));
    renderRoute(routeHost());
    await settle();

    expect(PRACTICE_SETUP_KEY).toBe("jackioh.practice.setup");
    expect(screen.getByTestId(T.hard)).toBeChecked();
    expect(screen.getByTestId(T.easy)).not.toBeChecked();
    expect((screen.getByTestId(T.deck) as HTMLSelectElement).value).toBe("preset:humans");
  });

  it("B32 a saved setup that is not JSON falls back to easy", async () => {
    window.localStorage.setItem(PRACTICE_SETUP_KEY, "{not json");
    renderRoute(routeHost());
    await settle();

    expect(screen.getByTestId(T.setup)).toBeInTheDocument();
    expect(screen.getByTestId(T.easy)).toBeChecked();
  });

  it("B32 a saved setup naming no real difficulty falls back to easy", async () => {
    window.localStorage.setItem(PRACTICE_SETUP_KEY, JSON.stringify({ difficulty: "nightmare", deck: "random" }));
    renderRoute(routeHost());
    await settle();

    expect(screen.getByTestId(T.easy)).toBeChecked();
    expect(screen.getByTestId(T.hard)).not.toBeChecked();
  });

  it("B32 a localStorage that throws still renders setup on easy", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("site data is blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("site data is blocked");
    });
    renderRoute(routeHost());
    await settle();

    expect(screen.getByTestId(T.setup)).toBeInTheDocument();
    expect(screen.getByTestId(T.easy)).toBeChecked();
  });

  it("B32 an active signed-in account with a saved loadout also gets saved:1..3", async () => {
    const loadLoadout = vi.fn(() => Promise.resolve(loadout(SAVED_DECKS)));
    renderRoute(routeHost(), { account: signedIn("active"), loadLoadout });

    await waitFor(() => {
      expect(savedOptions().sort()).toEqual(["saved:1", "saved:2", "saved:3"]);
    });
    expect(loadLoadout).toHaveBeenCalledWith("tok-1");
    expect(deckOptions()).toEqual(expect.arrayContaining(["random", ...PRESET_VALUES]));
  });

  it("B32 a pending account gets no saved decks", async () => {
    const loadLoadout = vi.fn(() => Promise.resolve(loadout(SAVED_DECKS)));
    renderRoute(routeHost(), { account: signedIn("pending"), loadLoadout });
    await settle();

    expect(screen.getByTestId(T.setup)).toBeInTheDocument();
    expect(savedOptions()).toEqual([]);
  });

  it("B32 a banned account gets no saved decks", async () => {
    const loadLoadout = vi.fn(() => Promise.resolve(loadout(SAVED_DECKS)));
    renderRoute(routeHost(), { account: signedIn("banned"), loadLoadout });
    await settle();

    expect(screen.getByTestId(T.setup)).toBeInTheDocument();
    expect(savedOptions()).toEqual([]);
  });

  it("B32 an active account whose loadout is null gets no saved decks", async () => {
    const loadLoadout = vi.fn(() => Promise.resolve(loadout(null)));
    renderRoute(routeHost(), { account: signedIn("active"), loadLoadout });
    await settle();

    expect(savedOptions()).toEqual([]);
    expect([...deckOptions()].sort()).toEqual(["random", ...PRESET_VALUES].sort());
  });

  it("B32 a loadout that fails to load simply shows no saved options", async () => {
    const loadLoadout = vi.fn(() => Promise.reject(new Error("503 service unavailable")));
    renderRoute(routeHost(), { account: signedIn("active"), loadLoadout });
    await settle();

    expect(loadLoadout).toHaveBeenCalled();
    expect(screen.getByTestId(T.setup)).toBeInTheDocument();
    expect(savedOptions()).toEqual([]);
    expect(screen.queryByTestId(T.error)).toBeNull();
  });

  it("B32 the route is not gated: an account still loading, or one that could not be read, gets setup", async () => {
    for (const account of [{ kind: "loading" }, { kind: "error", message: "offline" }] as Account[]) {
      renderRoute(routeHost(), { account });
      await settle();
      expect(screen.getByTestId(T.setup)).toBeInTheDocument();
      expect(savedOptions()).toEqual([]);
      cleanup();
    }
  });

  it("B32 the testids are the Surface's strings", () => {
    expect(practiceTestid).toMatchObject({
      setup: T.setup,
      deck: T.deck,
      start: T.start,
      loading: T.loading,
      error: T.error,
      hud: T.hud,
      thinking: T.thinking,
      newGame: T.newGame,
      leave: T.leave,
      leaveConfirm: T.leaveConfirm,
      leaveStay: T.leaveStay,
      result: T.result,
      playAgain: T.playAgain,
      changeSetup: T.changeSetup,
      viewBoard: T.viewBoard,
      outcome: T.outcome,
      deckHint: T.deckHint,
      deckPreview: T.deckPreview,
      deckCurve: T.deckCurve,
      menu: T.menu,
    });
    expect(practiceTestid.deckCard("core-001")).toBe("practice-deck-card-core-001");
    expect(practiceTestid.difficulty("easy")).toBe(T.easy);
    expect(practiceTestid.difficulty("medium")).toBe(T.medium);
    expect(practiceTestid.difficulty("hard")).toBe(T.hard);
  });
});

// ---------------------------------------------------------------------------------------------
// the saved-deck hint: why no saved deck is offered, worded for the account the page has
// ---------------------------------------------------------------------------------------------

describe("the deck hint says why no saved deck is offered, and never tells a signed-in player to sign in", () => {
  function hint(): string | null {
    return screen.queryByTestId(T.deckHint)?.textContent ?? null;
  }

  it("an anonymous visitor is told to sign in", async () => {
    renderRoute(routeHost());
    await settle();
    expect(hint()).toMatch(/sign in/i);
  });

  it("an active account that never saved a loadout is sent to Decks, not to sign in", async () => {
    renderRoute(routeHost(), {
      account: signedIn("active"),
      loadLoadout: vi.fn(() => Promise.resolve(loadout(null))),
    });
    await settle();
    expect(hint()).toMatch(/Save a loadout in Decks/);
    expect(hint()).not.toMatch(/sign in/i);
    expect(screen.getByRole("link", { name: "Decks" })).toHaveAttribute("href", "/decks");
  });

  it("a pending or banned account hears that its decks come once it is active", async () => {
    for (const status of ["pending", "banned"] as const) {
      renderRoute(routeHost(), { account: signedIn(status) });
      await settle();
      expect(hint()).toMatch(/once your account is active/);
      expect(hint()).not.toMatch(/sign in/i);
      cleanup();
    }
  });

  it("while the account or its loadout is read, the hint says it is looking", async () => {
    renderRoute(routeHost(), { account: { kind: "loading" } });
    await settle();
    expect(hint()).toMatch(/Looking for your saved decks/);
    cleanup();

    renderRoute(routeHost(), {
      account: signedIn("active"),
      loadLoadout: vi.fn(() => new Promise<LoadoutResponse>(() => undefined)),
    });
    await settle();
    expect(hint()).toMatch(/Looking for your saved decks/);
  });

  it("a loadout that fails to load, or an account that cannot be read, is reported as such", async () => {
    renderRoute(routeHost(), {
      account: signedIn("active"),
      loadLoadout: vi.fn(() => Promise.reject(new Error("503"))),
    });
    await settle();
    expect(hint()).toMatch(/could not be loaded/);
    expect(hint()).not.toMatch(/sign in/i);
    cleanup();

    renderRoute(routeHost(), { account: { kind: "error", message: "offline" } });
    await settle();
    expect(hint()).toMatch(/could not be loaded/);
  });

  it("an active account with saved decks gets them and no hint", async () => {
    renderRoute(routeHost(), {
      account: signedIn("active"),
      loadLoadout: vi.fn(() => Promise.resolve(loadout(SAVED_DECKS))),
    });
    await waitFor(() => {
      expect(savedOptions()).toHaveLength(3);
    });
    expect(hint()).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// the deck preview: the chosen deck's name, identity, curve and cards before Start
// ---------------------------------------------------------------------------------------------

describe("the setup previews the chosen deck", () => {
  function preview(): HTMLElement {
    return screen.getByTestId(T.deckPreview);
  }

  function previewedIds(): string[] {
    return Array.from(preview().querySelectorAll('[data-testid^="practice-deck-card-"]')).map((row) =>
      (row.getAttribute("data-testid") ?? "").replace("practice-deck-card-", ""),
    );
  }

  function curve(): Record<string, number> {
    return Object.fromEntries(
      Array.from(screen.getByTestId(T.deckCurve).querySelectorAll("[data-cost]")).map((bar) => [
        bar.getAttribute("data-cost") ?? "",
        Number(bar.getAttribute("data-count")),
      ]),
    );
  }

  it("every preset has a name of its own and a one-line identity, and the picker shows the name", () => {
    const names = PRACTICE_PRESETS.map((preset) => preset.name);
    expect(new Set(names).size).toBe(names.length);
    for (const preset of PRACTICE_PRESETS) {
      expect(preset.name).not.toMatch(/^(Preset|Starter)\b/);
      expect(preset.identity.length).toBeGreaterThan(20);
    }
  });

  it("a preset shows its name, identity, every card and a curve that adds up to the deck", async () => {
    const host = routeHost();
    renderRoute(host);
    await settle();
    expect(host.requests).toContainEqual({ type: "catalog" });

    for (const preset of PRACTICE_PRESETS) {
      fireEvent.change(screen.getByTestId(T.deck), { target: { value: `preset:${preset.id}` } });
      const option = Array.from((screen.getByTestId(T.deck) as HTMLSelectElement).options).find(
        (entry) => entry.value === `preset:${preset.id}`,
      );
      expect(option?.textContent).toBe(preset.name);
      expect(preview()).toHaveTextContent(preset.name);
      expect(preview()).toHaveTextContent(preset.identity);
      expect([...previewedIds()].sort()).toEqual([...preset.cards].sort());
      const bars = curve();
      expect(Object.values(bars).reduce((sum, count) => sum + count, 0)).toBe(preset.cards.length);
      // FAKE_DEFS: an id's last digit is its cost.
      const expectedAtTwo = preset.cards.filter((id) => id.endsWith("2")).length;
      expect(bars["2"]).toBe(expectedAtTwo);
    }
  });

  it("the random deck says it is dealt fresh each game and lists no cards", async () => {
    renderRoute(routeHost());
    await settle();
    expect((screen.getByTestId(T.deck) as HTMLSelectElement).value).toBe("random");
    expect(preview()).toHaveTextContent("Random deck");
    expect(preview()).toHaveTextContent(/every game/);
    expect(previewedIds()).toEqual([]);
  });

  it("a saved deck previews exactly its own cards", async () => {
    renderRoute(routeHost(), {
      account: signedIn("active"),
      loadLoadout: vi.fn(() => Promise.resolve(loadout(SAVED_DECKS))),
    });
    await waitFor(() => {
      expect(savedOptions()).toHaveLength(3);
    });
    fireEvent.change(screen.getByTestId(T.deck), { target: { value: "saved:2" } });
    expect(preview()).toHaveTextContent("Saved deck 2");
    expect([...previewedIds()].sort()).toEqual([...(SAVED_DECKS[1] ?? [])].sort());
  });

  it("a catalog the worker cannot give still leaves the deck named, explained and playable", async () => {
    const host = routeHost({ catalog: "fail" });
    renderRoute(host);
    await settle();
    fireEvent.change(screen.getByTestId(T.deck), { target: { value: "preset:blitz" } });
    expect(preview()).toHaveTextContent("Blitz");
    expect(preview()).toHaveTextContent(/card list could not be loaded/);
    expect(previewedIds()).toEqual([]);

    fireEvent.click(screen.getByTestId(T.start));
    await screen.findByTestId(T.hud);
    expect(host.starts()[0]?.deck).toEqual({ kind: "preset", id: "blitz" });
  });

  it("the setup's catalog host is closed once it has answered, and an autostarted game asks for no catalog", async () => {
    const host = routeHost();
    renderRoute(host);
    await settle();
    expect(host.disposals()).toBeGreaterThanOrEqual(1);
    cleanup();

    visit("?seed=cat1&difficulty=easy&deck=random&seat=p1");
    const autostarted = routeHost();
    renderRoute(autostarted);
    await screen.findByTestId(T.hud);
    expect(autostarted.requests.filter((body) => body.type === "catalog")).toEqual([]);
  });
});

describe("B32 deck choice values", () => {
  it("B32 random and presets map to their option values and back", () => {
    expect(deckChoiceValue({ kind: "random" })).toBe("random");
    expect(deckChoiceFromValue("random", null)).toEqual({ kind: "random" });
    for (const preset of PRACTICE_PRESETS) {
      expect(deckChoiceValue({ kind: "preset", id: preset.id })).toBe(`preset:${preset.id}`);
      expect(deckChoiceFromValue(`preset:${preset.id}`, null)).toEqual({ kind: "preset", id: preset.id });
    }
  });

  it("B32 saved:<n> names the n-th saved deck and maps back to the same value", () => {
    for (const n of [1, 2, 3]) {
      const choice = deckChoiceFromValue(`saved:${String(n)}`, SAVED_DECKS);
      expect(choice).toMatchObject({ kind: "saved", cards: SAVED_DECKS[n - 1] });
      if (choice === null) return;
      expect(deckChoiceValue(choice)).toBe(`saved:${String(n)}`);
    }
  });

  it("B32 a value naming nothing is null", () => {
    expect(deckChoiceFromValue("saved:1", null)).toBeNull();
    expect(deckChoiceFromValue("saved:0", SAVED_DECKS)).toBeNull();
    expect(deckChoiceFromValue("saved:4", SAVED_DECKS)).toBeNull();
    expect(deckChoiceFromValue("saved:two", SAVED_DECKS)).toBeNull();
    expect(deckChoiceFromValue("", null)).toBeNull();
    expect(deckChoiceFromValue("garbage", SAVED_DECKS)).toBeNull();
  });
});

describe("B32 URL parameters", () => {
  it("B32 readPracticeParams keeps every valid value", () => {
    expect(readPracticeParams("?seed=s1&difficulty=hard&deck=random&seat=p2&pace=fast")).toEqual({
      seed: "s1",
      difficulty: "hard",
      deck: "random",
      seat: "p2",
      pace: "fast",
    });
    expect(readPracticeParams("")).toEqual({});
  });

  it("B32 readPracticeParams drops an invalid difficulty, seat or pace", () => {
    expect(readPracticeParams("?difficulty=nightmare&seat=p3&pace=slow")).toEqual({});
    expect(readPracticeParams("?seed=s2&difficulty=Easy&seat=P1")).toEqual({ seed: "s2" });
  });
});

// ---------------------------------------------------------------------------------------------
// B33: starting a game
// ---------------------------------------------------------------------------------------------

describe("B33 starting renders the game under the practice HUD", () => {
  it("B33 practice-start sends the chosen setup and renders <Game> for the human seat", async () => {
    const host = routeHost();
    renderRoute(host);
    await settle();

    fireEvent.click(screen.getByTestId(T.medium));
    fireEvent.change(screen.getByTestId(T.deck), { target: { value: "random" } });
    fireEvent.click(screen.getByTestId(T.start));

    const hud = await screen.findByTestId(T.hud);
    const [config] = host.starts();
    expect(host.starts()).toHaveLength(1);
    if (config === undefined) return;
    expect(config.difficulty).toBe("medium");
    expect(config.deck).toEqual({ kind: "random" });
    expect(config.seed).toMatch(/^[0-9a-fA-F]{8}$/);
    expect(["p1", "p2"]).toContain(config.humanSeat);

    expect(screen.getByTestId("game")).toHaveAttribute("data-viewer", config.humanSeat);
    expect(hud).toHaveAttribute("data-difficulty", "medium");
    expect(hud).toHaveAttribute("data-human-seat", config.humanSeat);
    expect(hud).toHaveAttribute("data-ai-seat", opponentOf(config.humanSeat));
    expect(screen.queryByTestId(T.setup)).toBeNull();
  });

  it("B33 a saved deck chosen in setup travels as that deck's cards", async () => {
    const host = routeHost();
    renderRoute(host, { account: signedIn("active"), loadLoadout: vi.fn(() => Promise.resolve(loadout(SAVED_DECKS))) });
    await waitFor(() => {
      expect(savedOptions()).toContain("saved:2");
    });

    fireEvent.change(screen.getByTestId(T.deck), { target: { value: "saved:2" } });
    fireEvent.click(screen.getByTestId(T.start));
    await screen.findByTestId(T.hud);

    expect(host.starts()[0]?.deck).toMatchObject({ kind: "saved", cards: SAVED_DECKS[1] });
  });

  it("B33 ?difficulty=&deck= autostarts with the URL's seed and seat", async () => {
    visit("?seed=abc123&difficulty=hard&deck=preset:humans&seat=p2");
    const host = routeHost();
    renderRoute(host);

    const hud = await screen.findByTestId(T.hud);
    expect(host.starts()).toEqual([
      { seed: "abc123", difficulty: "hard", humanSeat: "p2", deck: { kind: "preset", id: "humans" } },
    ]);
    expect(screen.getByTestId("game")).toHaveAttribute("data-viewer", "p2");
    expect(hud).toHaveAttribute("data-difficulty", "hard");
    expect(hud).toHaveAttribute("data-human-seat", "p2");
    expect(hud).toHaveAttribute("data-ai-seat", "p1");
    expect(screen.queryByTestId(T.setup)).toBeNull();
  });

  it("B33 no autostart without a valid difficulty and a random or preset deck", async () => {
    for (const search of [
      "?difficulty=nightmare&deck=random",
      "?difficulty=easy&deck=saved:1",
      "?difficulty=easy&deck=preset:",
      "?difficulty=easy",
      "?deck=random",
    ]) {
      visit(search);
      const host = routeHost();
      renderRoute(host);
      await settle();
      expect(screen.getByTestId(T.setup), search).toBeInTheDocument();
      expect(host.starts(), search).toEqual([]);
      cleanup();
    }
  });

  it("B33 an invalid ?seat is dropped: the autostart still seats the human on p1 or p2", async () => {
    visit("?seed=seat1&difficulty=easy&deck=random&seat=p3");
    const host = routeHost();
    renderRoute(host);

    const hud = await screen.findByTestId(T.hud);
    const [config] = host.starts();
    expect(host.starts()).toHaveLength(1);
    if (config === undefined) return;
    expect(config.seed).toBe("seat1");
    expect(["p1", "p2"]).toContain(config.humanSeat);
    expect(hud).toHaveAttribute("data-human-seat", config.humanSeat);
    expect(screen.getByTestId("game")).toHaveAttribute("data-viewer", config.humanSeat);
  });

  it("B33 practice-loading shows while the start is in flight", async () => {
    visit("?seed=load1&difficulty=easy&deck=random&seat=p1");
    const host = routeHost({ start: "hold" });
    renderRoute(host);

    expect(await screen.findByTestId(T.loading)).toBeInTheDocument();
    expect(screen.queryByTestId(T.hud)).toBeNull();

    await act(async () => {
      host.releaseStart();
      await Promise.resolve();
    });
    expect(await screen.findByTestId(T.hud)).toBeInTheDocument();
    expect(screen.queryByTestId(T.loading)).toBeNull();
  });

  it("B33 a start the core refuses shows practice-error with its message and no board", async () => {
    visit("?seed=bad1&difficulty=easy&deck=random&seat=p1");
    const host = routeHost({ start: "failed", failure: "the engine refused the deck" });
    renderRoute(host);

    const error = await screen.findByTestId(T.error);
    expect(error).toHaveTextContent("the engine refused the deck");
    expect(screen.queryByTestId("game")).toBeNull();
    expect(screen.queryByTestId(T.hud)).toBeNull();
  });

  it("B33 a board action goes to the host as an act", async () => {
    visit("?seed=act1&difficulty=easy&deck=random&seat=p1");
    const host = routeHost();
    renderRoute(host);
    await screen.findByTestId(T.hud);

    fireEvent.click(screen.getByTestId("end-turn"));
    await waitFor(() => {
      expect(host.requests).toContainEqual({ type: "act", action: { type: "endTurn" } });
    });
  });

  it("B33 the HUD shows the think indicator while the AI owes an action, and drops it once it does not", async () => {
    visit("?seed=think1&difficulty=easy&deck=random&seat=p1");
    const host = routeHost({ aiToAct: true, holdAiSteps: true });
    renderRoute(host);

    const indicator = await screen.findByTestId(T.thinking);
    expect(indicator).toHaveAttribute("role", "status");
    expect(indicator).toHaveTextContent("AI is thinking…");
    expect(screen.getByTestId(T.hud)).toHaveAttribute("data-thinking", "true");
    // The practice table (`.practice-table`, practice.css) wraps the board and carries the same flag,
    // which is what lights the AI's hero while it thinks.
    const table = screen.getByTestId("game").closest(".practice-table");
    expect(table).not.toBeNull();
    expect(table).toHaveAttribute("data-thinking", "true");
    expect(table).toHaveAttribute("data-difficulty", "easy");

    await waitFor(() => {
      expect(host.requests).toContainEqual({ type: "aiStep" });
    });
    await act(async () => {
      host.releaseAiStep(false);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.queryByTestId(T.thinking)).toBeNull();
    });
    expect(screen.getByTestId(T.hud)).toHaveAttribute("data-thinking", "false");
    expect(screen.getByTestId("game").closest(".practice-table")).toHaveAttribute("data-thinking", "false");
  });

  it("the AI's next step waits while anything on the board carries data-animating", async () => {
    visit("?seed=gate1&difficulty=easy&deck=random&seat=p1");
    const host = routeHost({ aiToAct: true });
    // Long enough that the mark lands before the first gap runs out even on a loaded machine; the
    // wait below is longer still, so a step that ignored the mark would have been sent.
    const gap = 400;
    renderRoute(host, { pacing: { firstActionMs: gap, actionGapMs: gap, promptAnswerMs: gap } });
    await screen.findByTestId(T.hud);

    // An animation in flight, as the runner marks one (game/animations.ts).
    const board = screen.getByTestId("game");
    const busy = document.createElement("span");
    busy.setAttribute("data-animating", "summoned");
    board.appendChild(busy);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, gap * 2));
    });
    expect(host.requests.filter((body) => body.type === "aiStep"), "no step while the board animates").toEqual([]);

    busy.remove();
    await waitFor(() => {
      expect(host.requests).toContainEqual({ type: "aiStep" });
    });
  });

  it("the AI's next step waits while the page marks a voice line with data-speaking", async () => {
    visit("?seed=voice1&difficulty=easy&deck=random&seat=p1");
    const host = routeHost({ aiToAct: true });
    const gap = 40;
    // Marked before the game starts, so the very first gap already waits for it.
    document.body.setAttribute("data-speaking", "core-011-play");
    renderRoute(host, { pacing: { firstActionMs: gap, actionGapMs: gap, promptAnswerMs: gap } });
    await screen.findByTestId(T.hud);

    // The audio layer's contract: any element marks a line while it plays.
    try {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, gap * 5));
      });
      expect(host.requests.filter((body) => body.type === "aiStep"), "no step while a line plays").toEqual([]);
    } finally {
      document.body.removeAttribute("data-speaking");
    }
    await waitFor(() => {
      expect(host.requests).toContainEqual({ type: "aiStep" });
    });
  });

  it("a voice mark nobody clears holds the AI for PRACTICE_VOICE_HOLD_MAX_MS and no longer", async () => {
    vi.useFakeTimers();
    try {
      visit("?seed=voice2&difficulty=easy&deck=random&seat=p1");
      const host = routeHost({ aiToAct: true, holdAiSteps: true });
      const gap = 40;
      document.body.setAttribute("data-speaking", "stuck");
      renderRoute(host, { pacing: { firstActionMs: gap, actionGapMs: gap, promptAnswerMs: gap } });
      await settle();
      const aiSteps = (): number => host.requests.filter((body) => body.type === "aiStep").length;

      await act(async () => {
        vi.advanceTimersByTime(PRACTICE_VOICE_HOLD_MAX_MS - 1);
        await Promise.resolve();
      });
      expect(aiSteps(), "held by the mark").toBe(0);
      await act(async () => {
        vi.advanceTimersByTime(1 + gap);
        await Promise.resolve();
      });
      expect(aiSteps(), "the cap ran out, so the AI plays on").toBe(1);
    } finally {
      document.body.removeAttribute("data-speaking");
      vi.useRealTimers();
    }
  });

  it("B33 practice-new-game asks first mid-game, and confirming leaves the game for setup", async () => {
    visit("?seed=again1&difficulty=easy&deck=random&seat=p1");
    const host = routeHost();
    renderRoute(host);
    await screen.findByTestId(T.hud);

    fireEvent.click(screen.getByTestId(T.newGame));
    const leave = await screen.findByTestId(T.leave);
    expect(leave).toHaveAttribute("role", "alertdialog");
    // Staying is the default: it has the focus, so Enter on a stray tap keeps the game.
    expect(screen.getByTestId(T.leaveStay)).toHaveFocus();
    expect(screen.getByTestId("game")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId(T.leaveConfirm));
    expect(await screen.findByTestId(T.setup)).toBeInTheDocument();
    expect(screen.queryByTestId("game")).toBeNull();
    expect(screen.queryByTestId(T.hud)).toBeNull();
    expect(screen.queryByTestId(T.leave)).toBeNull();
  });

  it("B33 Keep playing, Escape or a click outside closes the question and the game carries on", async () => {
    visit("?seed=stay1&difficulty=easy&deck=random&seat=p1");
    const host = routeHost();
    renderRoute(host);
    await screen.findByTestId(T.hud);

    fireEvent.click(screen.getByTestId(T.newGame));
    fireEvent.click(await screen.findByTestId(T.leaveStay));
    expect(screen.queryByTestId(T.leave)).toBeNull();

    fireEvent.click(screen.getByTestId(T.newGame));
    await screen.findByTestId(T.leave);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByTestId(T.leave)).toBeNull();
    });

    fireEvent.click(screen.getByTestId(T.newGame));
    const scrim = (await screen.findByTestId(T.leave)).parentElement;
    expect(scrim).not.toBeNull();
    fireEvent.click(scrim as HTMLElement);
    expect(screen.queryByTestId(T.leave)).toBeNull();

    expect(screen.getByTestId("game")).toBeInTheDocument();
    expect(screen.queryByTestId(T.setup)).toBeNull();
    expect(host.starts()).toHaveLength(1);
  });

  it("B33 once the game is over, practice-new-game goes straight back to setup", async () => {
    visit("?seed=over9&difficulty=easy&deck=random&seat=p1");
    const host = routeHost();
    renderRoute(host);
    await screen.findByTestId(T.hud);
    fireEvent.click(screen.getByTestId("concede"));
    await screen.findByTestId(T.result);

    fireEvent.click(screen.getByTestId(T.newGame));
    expect(await screen.findByTestId(T.setup)).toBeInTheDocument();
    expect(screen.queryByTestId(T.leave)).toBeNull();
  });

  it("practice-menu asks first mid-game, and confirming leaves for the main menu", async () => {
    visit("?seed=menu1&difficulty=easy&deck=random&seat=p1");
    renderRoute(routeHost());
    await screen.findByTestId(T.hud);

    fireEvent.click(screen.getByTestId(T.menu));
    const leave = await screen.findByTestId(T.leave);
    expect(leave).toHaveTextContent("main menu");
    expect(screen.getByTestId(T.leaveStay)).toHaveFocus();
    expect(window.location.pathname).toBe("/practice");

    fireEvent.click(screen.getByTestId(T.leaveConfirm));
    expect(window.location.pathname).toBe("/");
  });

  it("once the game is over, practice-menu goes straight to the main menu", async () => {
    visit("?seed=menu2&difficulty=easy&deck=random&seat=p1");
    renderRoute(routeHost());
    await screen.findByTestId(T.hud);
    fireEvent.click(screen.getByTestId("concede"));
    await screen.findByTestId(T.result);

    fireEvent.click(screen.getByTestId(T.menu));
    expect(screen.queryByTestId(T.leave)).toBeNull();
    expect(window.location.pathname).toBe("/");
  });

  it("a reload or a closed tab asks first while a game is on, and not at setup or once it is over", async () => {
    function unloadIsCancelled(): boolean {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }

    renderRoute(routeHost());
    await settle();
    expect(screen.getByTestId(T.setup)).toBeInTheDocument();
    expect(unloadIsCancelled(), "the setup screen").toBe(false);
    cleanup();

    visit("?seed=unload1&difficulty=easy&deck=random&seat=p1");
    renderRoute(routeHost());
    await screen.findByTestId(T.hud);
    expect(unloadIsCancelled(), "a game in progress").toBe(true);

    fireEvent.click(screen.getByTestId("concede"));
    await screen.findByTestId(T.result);
    expect(unloadIsCancelled(), "a finished game").toBe(false);
    cleanup();
    expect(unloadIsCancelled(), "after the route unmounts").toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// the end of a game
// ---------------------------------------------------------------------------------------------

describe("the result dialog", () => {
  async function concede(search: string): Promise<RouteHost> {
    visit(search);
    const host = routeHost();
    renderRoute(host);
    await screen.findByTestId(T.hud);
    expect(screen.queryByTestId(T.result)).toBeNull();
    expect(screen.queryByTestId(T.outcome)).toBeNull();
    fireEvent.click(screen.getByTestId("concede"));
    await screen.findByTestId(T.result);
    return host;
  }

  it("a finished game opens the dialog with the viewer's outcome and why, and the HUD shows it too", async () => {
    await concede("?seed=over1&difficulty=medium&deck=random&seat=p2");

    const dialog = screen.getByTestId(T.result);
    expect(dialog).toHaveAttribute("role", "dialog");
    expect(dialog).toHaveAttribute("data-outcome", "loss");
    expect(dialog).toHaveTextContent("Defeat");
    expect(dialog).toHaveTextContent("You conceded.");
    expect(dialog).toHaveTextContent("Medium");
    expect(screen.getByTestId(T.playAgain)).toHaveFocus();
    expect(screen.getByTestId(T.outcome)).toHaveAttribute("data-outcome", "loss");
    // The board's own overlay still renders under the dialog, for every other consumer of Game.
    expect(screen.getByTestId("result-overlay")).toHaveTextContent("Loss");
  });

  it("Play again starts the same difficulty and deck with a fresh seed, and closes the dialog", async () => {
    const host = await concede("?difficulty=hard&deck=preset:humans&seat=p1");

    fireEvent.click(screen.getByTestId(T.playAgain));
    await waitFor(() => {
      expect(host.starts()).toHaveLength(2);
    });
    const [first, second] = host.starts();
    expect(second).toMatchObject({ difficulty: "hard", deck: { kind: "preset", id: "humans" }, humanSeat: "p1" });
    expect(second?.seed).not.toBe(first?.seed);
    await waitFor(() => {
      expect(screen.queryByTestId(T.result)).toBeNull();
    });
    expect(screen.getByTestId(T.hud)).toHaveAttribute("data-difficulty", "hard");
  });

  it("View the board closes the dialog, Escape does too, and the HUD's outcome reopens it", async () => {
    await concede("?seed=over3&difficulty=easy&deck=random&seat=p1");

    fireEvent.click(screen.getByTestId(T.viewBoard));
    expect(screen.queryByTestId(T.result)).toBeNull();
    expect(screen.getByTestId("game")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId(T.outcome));
    expect(screen.getByTestId(T.result)).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId(T.result)).toBeNull();
  });

  it("Change setup returns to the setup screen", async () => {
    await concede("?seed=over4&difficulty=easy&deck=random&seat=p1");

    fireEvent.click(screen.getByTestId(T.changeSetup));
    expect(await screen.findByTestId(T.setup)).toBeInTheDocument();
    expect(screen.queryByTestId(T.result)).toBeNull();
    expect(screen.queryByTestId(T.hud)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// the dev handle spec 13 drives (B40)
// ---------------------------------------------------------------------------------------------

describe("B40 the dev handle", () => {
  it("B40 window.__jackiohPractice names the AI seat and the view, and snapshot() is the core's debug", async () => {
    visit("?seed=handle1&difficulty=easy&deck=random&seat=p2");
    const host = routeHost();
    renderRoute(host);
    await screen.findByTestId(T.hud);

    await waitFor(() => {
      expect(window.__jackiohPractice?.aiSeat).toBe("p1");
    });
    const handle = window.__jackiohPractice;
    if (handle === undefined) return;
    expect(handle.view?.viewer).toBe("p2");
    expect(handle.thinking).toBe(false);

    let debug: PracticeDebug | undefined;
    await act(async () => {
      debug = await handle.snapshot();
    });
    expect(debug).toEqual(host.debug);
    expect(host.requests).toContainEqual({ type: "debug" });
  });
});

// ---------------------------------------------------------------------------------------------
// §Surface: the remembered setup, and the pacing the route picks when none is injected
// ---------------------------------------------------------------------------------------------

describe("Surface: the setup is remembered, and the pacing follows ?pace and reduced motion", () => {
  it("starting a game stores its difficulty and deck under jackioh.practice.setup, and the next visit opens on them", async () => {
    renderRoute(routeHost());
    await settle();
    fireEvent.click(screen.getByTestId(T.hard));
    fireEvent.change(screen.getByTestId(T.deck), { target: { value: "preset:humans" } });
    fireEvent.click(screen.getByTestId(T.start));
    await screen.findByTestId(T.hud);

    expect(JSON.parse(window.localStorage.getItem(PRACTICE_SETUP_KEY) ?? "null")).toEqual({
      difficulty: "hard",
      deck: "preset:humans",
    });

    cleanup();
    renderRoute(routeHost());
    await settle();
    expect(screen.getByTestId(T.hard)).toBeChecked();
    expect((screen.getByTestId(T.deck) as HTMLSelectElement).value).toBe("preset:humans");
  });

  it("a localStorage that refuses the write still starts the game", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage is full");
    });
    const host = routeHost();
    renderRoute(host);
    await settle();
    fireEvent.click(screen.getByTestId(T.start));

    expect(await screen.findByTestId(T.hud)).toBeInTheDocument();
    expect(host.starts()).toHaveLength(1);
  });

  const pacings: { name: string; search: string; reduced: boolean; expected: PracticePacing }[] = [
    { name: "with neither, the full pacing", search: "", reduced: false, expected: PRACTICE_PACING },
    { name: "under reduced motion, the reduced pacing", search: "", reduced: true, expected: PRACTICE_PACING_REDUCED },
    { name: "with ?pace=fast outside production, the fast pacing", search: "&pace=fast", reduced: false, expected: PRACTICE_PACING_FAST },
  ];

  for (const { name, search, reduced, expected } of pacings) {
    it(`${name}: the AI's first step waits exactly firstActionMs`, async () => {
      vi.useFakeTimers();
      setReducedMotion(reduced);
      try {
        visit(`?seed=pace1&difficulty=easy&deck=random&seat=p1${search}`);
        const host = routeHost({ aiToAct: true, holdAiSteps: true });
        renderRoute(host, { pacing: undefined });
        await settle();
        const aiSteps = (): number => host.requests.filter((body) => body.type === "aiStep").length;

        expect(host.starts()).toHaveLength(1);
        expect(aiSteps()).toBe(0);
        if (expected.firstActionMs > 0) {
          await act(async () => {
            vi.advanceTimersByTime(expected.firstActionMs - 1);
            await Promise.resolve();
          });
          expect(aiSteps()).toBe(0);
          await act(async () => {
            vi.advanceTimersByTime(1);
            await Promise.resolve();
          });
        } else {
          await act(async () => {
            vi.advanceTimersByTime(0);
            await Promise.resolve();
          });
        }
        expect(aiSteps()).toBe(1);
      } finally {
        setReducedMotion(false);
        vi.useRealTimers();
      }
    });
  }
});
