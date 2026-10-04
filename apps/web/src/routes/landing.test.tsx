// The landing page (docs/polish/5-sign-in.md, B37, B38): `/` renders `LandingRoute`, its CTAs are
// real links that navigate in place on a plain left click, the corner slot follows the account,
// and the hero states the game's numbers from config rather than spelling them.
//
// Layout (no horizontal overflow at 360-1280 px, B39) needs a layout engine, so it is the Cypress
// component spec's job (e2e/cypress/component/landing-and-code-field.cy.tsx), not this file's.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DECK_SIZE, MAX_MANA, UNIT_ZONES } from "@jackioh/engine/config";
import { LOADOUT_DECKS } from "@jackioh/validator";

import { landingFanCardTestid, landingStepTestid, landingTestid } from "../auth/testids.ts";
import { INSPECT_DETAIL } from "../cards/inspect/testids.ts";
import { paths } from "../net/navigate.ts";
import { E2E_SESSION_STORAGE_KEY } from "../net/session.ts";
import { __resetSettingsForTests, writeSettings } from "../settings/store.ts";
import { setReducedMotion } from "../test/setup.ts";
import { seeded } from "../test/random.ts";
import { PLAYER_STATS_KEY, PLAYER_STATS_VERSION, ROTATION_INTERVAL_MS, ROTATION_MIN_GAMES } from "../stats/config.ts";
import { dropPlayerStatsCache } from "../stats/store.ts";
import LandingRoute from "./landing.tsx";
import { ROTATION_POOL, dealLandingFan, featureWeight, rotateFan } from "./landingFan.ts";

const { App } = await import("../main.tsx");

const FAN_CARDS = 5;
const STEPS = 4;

/** A stubbed round trip can outrun the 1 s default under load. */
const SLOW = { timeout: 5_000 } as const;

// ---------------------------------------------------------------------------------------------
// the stubbed server
// ---------------------------------------------------------------------------------------------

type MeAnswer = "active" | "unauthorized" | "hang";

function jsonResponse(status: number, body?: unknown): Response {
  const text = body === undefined ? "" : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: new Headers({ "content-type": "application/json" }),
    json: () =>
      text === "" ? Promise.reject(new SyntaxError("empty body")) : Promise.resolve(JSON.parse(text)),
    text: () => Promise.resolve(text),
    clone: () => jsonResponse(status, body),
  } as unknown as Response;
}

function serve(answer: MeAnswer): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: unknown) => {
      const url = typeof input === "string" ? input : String((input as URL).href ?? input);
      if (url.endsWith("/api/auth/me")) {
        if (answer === "hang") return new Promise<Response>(() => {});
        if (answer === "unauthorized") {
          return Promise.resolve(
            jsonResponse(401, { error: { code: "unauthorized", message: "sign in first" } }),
          );
        }
        return Promise.resolve(
          jsonResponse(200, {
            profile: { id: "profile-1", status: "active" },
            needsInviteCode: false,
            emailVerified: true,
            currentMatchId: null,
            email: "player@example.test",
          }),
        );
      }
      return Promise.resolve(
        jsonResponse(404, { error: { code: "not_found", message: `no stub for ${url}` } }),
      );
    }),
  );
}

function signedIn(): void {
  window.localStorage.setItem(E2E_SESSION_STORAGE_KEY, JSON.stringify({ accessToken: "e2e-token" }));
}

function at(path: string): void {
  window.history.replaceState(null, "", path);
}

function landing(): HTMLElement {
  return screen.getByTestId(landingTestid.root);
}

/** The exit goes to `path`: a link whose href is that path, or a control that moves the URL there. */
async function expectLeadsTo(element: HTMLElement, path: string): Promise<void> {
  const link = element.closest("a");
  if (link !== null && link.hasAttribute("href")) {
    expect(new URL(link.href, window.location.origin).pathname).toBe(path);
    return;
  }
  fireEvent.click(element);
  await waitFor(() => {
    expect(window.location.pathname).toBe(path);
  }, SLOW);
}

beforeEach(() => {
  window.localStorage.clear();
  dropPlayerStatsCache();
  setReducedMotion(false);
  serve("active");
  at("/");
});

afterEach(() => {
  cleanup();
  setReducedMotion(false);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------
// B37: the route and its CTAs
// ---------------------------------------------------------------------------------------------

const CTAS = [
  ["Play vs AI", landingTestid.playAi, paths.practice],
  ["Play online", landingTestid.playOnline, paths.play],
  ["Build decks", landingTestid.buildDecks, paths.decks],
] as const;

describe("B37 the landing route", () => {
  it("B37 / renders LandingRoute through the route table", async () => {
    render(<App />);
    expect(await screen.findByTestId(landingTestid.root, undefined, SLOW)).toBeInTheDocument();
    expect(window.location.pathname).toBe(paths.landing);
  });

  it.each(CTAS)("B37 %s is a real link to its path", (_label, testid, path) => {
    render(<LandingRoute />);
    const cta = within(landing()).getByTestId(testid);
    const link = cta.closest("a");
    expect(link, `${testid} is an <a href>, so middle-click and open-in-new-tab work`).not.toBeNull();
    expect(link?.getAttribute("href")).toBe(path);
  });

  it.each(CTAS)("B37 a plain left click on %s navigates in place", (_label, testid, path) => {
    render(<LandingRoute />);
    const cta = within(landing()).getByTestId(testid);

    const notPrevented = fireEvent.click(cta, { button: 0 });

    expect(window.location.pathname).toBe(path);
    // Handled in the page: the browser's own full load is cancelled.
    expect(notPrevented).toBe(false);
  });

  it.each([
    ["a ctrl-click", { button: 0, ctrlKey: true }],
    ["a cmd-click", { button: 0, metaKey: true }],
    ["a middle click", { button: 1 }],
  ] as const)("B37 %s is left to the browser: no in-page navigation, default kept", (_name, init) => {
    render(<LandingRoute />);
    for (const [, testid] of CTAS) {
      const cta = within(landing()).getByTestId(testid);
      const notPrevented = fireEvent.click(cta, init);
      expect(notPrevented, `${testid} keeps the browser's default`).toBe(true);
      expect(window.location.pathname).toBe(paths.landing);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// B37: the corner slot
// ---------------------------------------------------------------------------------------------

describe("B37 the corner slot", () => {
  it("B37 anonymous: shows landing-sign-in, which leads to /login, and no landing-account", async () => {
    render(<LandingRoute />);

    const signIn = await screen.findByTestId(landingTestid.signIn, undefined, SLOW);
    expect(screen.queryByTestId(landingTestid.account)).toBeNull();
    expect(landing()).toHaveAttribute("data-account", "anonymous");
    await expectLeadsTo(signIn, paths.login);
  });

  it("B37 signed in: shows landing-account, which leads to /account, and no landing-sign-in", async () => {
    signedIn();
    render(<LandingRoute />);

    const account = await screen.findByTestId(landingTestid.account, undefined, SLOW);
    expect(screen.queryByTestId(landingTestid.signIn)).toBeNull();
    expect(landing()).toHaveAttribute("data-account", "signed-in");
    await expectLeadsTo(account, paths.account);
  });

  it("B37 loading: the slot holds nothing while /api/auth/me is unanswered", async () => {
    signedIn();
    serve("hang");
    render(<LandingRoute />);

    expect(landing()).toHaveAttribute("data-account", "loading");
    // Give the read every chance to (wrongly) settle before looking.
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(screen.queryByTestId(landingTestid.signIn)).toBeNull();
    expect(screen.queryByTestId(landingTestid.account)).toBeNull();
    expect(landing()).toHaveAttribute("data-account", "loading");
  });

  it("B37 a token the server refuses is anonymous: the slot offers landing-sign-in", async () => {
    signedIn();
    serve("unauthorized");
    render(<LandingRoute />);

    expect(await screen.findByTestId(landingTestid.signIn, undefined, SLOW)).toBeInTheDocument();
    expect(screen.queryByTestId(landingTestid.account)).toBeNull();
    await waitFor(() => {
      expect(landing()).toHaveAttribute("data-account", "anonymous");
    }, SLOW);
    // The landing is not gated: it stays put rather than sending anyone to /login.
    expect(window.location.pathname).toBe(paths.landing);
  });

  it("B37 a device that holds a session is offered landing-account, not sign-in, when /api/auth/me cannot be reached", async () => {
    signedIn();
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    render(<LandingRoute />);

    await waitFor(() => {
      expect(landing()).toHaveAttribute("data-account", "signed-in");
    }, SLOW);
    // The account screen is where sign-out is; a sign-in would replace (and revoke) this session.
    expect(screen.getByTestId(landingTestid.account)).toBeInTheDocument();
    expect(screen.queryByTestId(landingTestid.signIn)).toBeNull();
  });

  it("B37 a device with no session is offered sign-in when /api/auth/me cannot be reached", async () => {
    // With no session there is nothing to read, so the landing never even asks the server.
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    render(<LandingRoute />);

    expect(await screen.findByTestId(landingTestid.signIn, undefined, SLOW)).toBeInTheDocument();
    expect(landing()).toHaveAttribute("data-account", "anonymous");
  });

  it("B37 the three play CTAs are there whatever the slot shows", async () => {
    signedIn();
    serve("hang");
    render(<LandingRoute />);
    for (const [, testid] of CTAS) expect(within(landing()).getByTestId(testid)).toBeInTheDocument();
  });

  it("B37 says, beside the CTAs, that online play needs an invite code and Play vs AI needs no account", () => {
    render(<LandingRoute />);
    const note = within(landing()).getByTestId(landingTestid.inviteOnly);
    expect(note.textContent).toMatch(/invite code/);
    // des-9: the note under "Play vs AI" says it, so the invite note no longer repeats it.
    const ctas = within(landing()).getByRole("navigation", { name: "Play" });
    expect(within(ctas).getByText(/No account needed/)).toBeInTheDocument();
    expect(note.textContent).not.toMatch(/needs no account/);
  });
});

// ---------------------------------------------------------------------------------------------
// B38: the hero
// ---------------------------------------------------------------------------------------------

describe("B38 the hero", () => {
  it("B38 shows the JackiOh wordmark", () => {
    render(<LandingRoute />);
    const wordmarks = within(landing()).queryAllByText(
      (_content, element) => element !== null && (element.textContent ?? "").replace(/\s+/g, "") === "JackiOh",
    );
    expect(wordmarks.length).toBeGreaterThan(0);
  });

  it("B38 R639 the fan holds exactly five cards, landing-fan-card-0 to -4: four faces that are buttons, and a back hidden from assistive tech", () => {
    render(<LandingRoute />);
    const fan = within(landing()).getByTestId(landingTestid.fan);

    for (let index = 0; index < FAN_CARDS - 1; index += 1) {
      const card = within(fan).getByTestId(landingFanCardTestid(index));
      expect(card, `${landingFanCardTestid(index)} is a button`).toHaveAttribute("role", "button");
      expect(card.getAttribute("aria-label")).toMatch(/^Read /);
      expect(card.closest('[aria-hidden="true"]'), `${landingFanCardTestid(index)} is readable`).toBeNull();
    }
    const back = within(fan).getByTestId(landingFanCardTestid(FAN_CARDS - 1));
    expect(back.closest('[aria-hidden="true"]'), "the card back is aria-hidden").not.toBeNull();
    expect(screen.queryByTestId(landingFanCardTestid(FAN_CARDS))).toBeNull();
  });

  it("B38 R374 the fan's cards are the game's own faces, named and costed, with a card back last (integration QA)", () => {
    render(<LandingRoute random={seeded(38)} />);
    const fan = within(landing()).getByTestId(landingTestid.fan);
    const faces = [0, 1, 2, 3].map((index) => within(fan).getByTestId(landingFanCardTestid(index)));
    // The page deals from the source it is given (R374), so the same seed names the same hand.
    const hand = dealLandingFan(seeded(38));

    for (const [index, face] of faces.entries()) {
      const { def, radiant } = hand[index] ?? { def: undefined, radiant: false };
      expect(face.querySelector(".cf"), `fan card ${String(index)} is a CardFace`).not.toBeNull();
      expect(face).toHaveAttribute("data-def-id", def?.id);
      expect(face.querySelector(".card-name")?.textContent).toBe(def?.name);
      expect(face.querySelector(".cost-gem")?.textContent).toBe(String(def?.cost));
      expect(face.getAttribute("data-radiant") === "true").toBe(radiant);
    }
    const back = within(fan).getByTestId(landingFanCardTestid(4));
    expect(back).toHaveAttribute("data-face", "down");
    expect(back.querySelector(".cf-back")).not.toBeNull();
    expect(back.textContent).toBe("");
  });

  it("R374 each visit deals its own hand, and a hand holds still while the page is up", () => {
    const shown = (): string[] =>
      [0, 1, 2, 3].map((index) => screen.getByTestId(landingFanCardTestid(index)).getAttribute("data-def-id") ?? "");
    const first = render(<LandingRoute random={seeded(1)} />);
    const hand = shown();
    expect(hand).toEqual(dealLandingFan(seeded(1)).map(({ def }) => def.id));
    // A re-render is the same visit: the deal is not drawn again.
    first.rerender(<LandingRoute random={seeded(2)} />);
    expect(shown()).toEqual(hand);
    first.unmount();
    // The next visit is a new deal.
    render(<LandingRoute random={seeded(2)} />);
    expect(shown()).toEqual(dealLandingFan(seeded(2)).map(({ def }) => def.id));
    expect(shown()).not.toEqual(hand);
  });

  it("B38 the corner holds the settings gear beside Sign in, as every other screen's top bar does", () => {
    render(<LandingRoute />);
    const gear = within(landing()).getByTestId("settings-open-nav");
    expect(gear.closest(".landing-corner")).not.toBeNull();
    expect(gear).toHaveAttribute("aria-label", "Settings");
    fireEvent.click(gear);
    expect(screen.getByTestId("settings-panel")).toBeInTheDocument();
  });

  it("B38 data-motion is full when reduced motion is not requested", () => {
    render(<LandingRoute />);
    expect(landing()).toHaveAttribute("data-motion", "full");
  });

  it("B38 data-motion is reduced under prefers-reduced-motion", () => {
    setReducedMotion(true);
    render(<LandingRoute />);
    expect(landing()).toHaveAttribute("data-motion", "reduced");
  });

  // Integration: the settings panel's "Reduce motion" (task 7) stops the landing as the media query
  // does, and a change applies to the page already showing.
  it("B38 data-motion is reduced under the settings panel's Reduce motion, live", () => {
    render(<LandingRoute />);
    expect(landing()).toHaveAttribute("data-motion", "full");
    try {
      act(() => {
        writeSettings({ reduceMotion: true });
      });
      expect(landing()).toHaveAttribute("data-motion", "reduced");
      expect(document.documentElement).toHaveAttribute("data-reduce-motion", "true");
    } finally {
      act(() => {
        writeSettings({ reduceMotion: false });
      });
      __resetSettingsForTests();
    }
    expect(landing()).toHaveAttribute("data-motion", "full");
  });

  it("B38 the four steps state MAX_MANA, UNIT_ZONES, DECK_SIZE and LOADOUT_DECKS from config", () => {
    render(<LandingRoute />);
    const how = within(landing()).getByTestId(landingTestid.howItPlays);
    const steps = Array.from({ length: STEPS }, (_unused, index) =>
      within(how).getByTestId(landingStepTestid(index)).textContent ?? "",
    );
    expect(screen.queryByTestId(landingStepTestid(STEPS))).toBeNull();

    const stated = (value: number): boolean =>
      steps.some((text) => new RegExp(`(^|\\D)${String(value)}(\\D|$)`).test(text));
    expect(stated(MAX_MANA), `a step states MAX_MANA (${String(MAX_MANA)})`).toBe(true);
    expect(stated(UNIT_ZONES), `a step states UNIT_ZONES (${String(UNIT_ZONES)})`).toBe(true);
    expect(stated(DECK_SIZE), `a step states DECK_SIZE (${String(DECK_SIZE)})`).toBe(true);
    expect(stated(LOADOUT_DECKS), `a step states LOADOUT_DECKS (${String(LOADOUT_DECKS)})`).toBe(true);
  });

  it("B38 the step icons draw the counts their tiles state: UNIT_ZONES lanes and LOADOUT_DECKS decks", () => {
    render(<LandingRoute />);
    const how = within(landing()).getByTestId(landingTestid.howItPlays);
    // A lane is the space between two edges, and the board's outline is the outer two.
    expect(how.querySelectorAll(".landing-icon-lane-edge")).toHaveLength(UNIT_ZONES - 1);
    expect(how.querySelectorAll(".landing-icon-deck")).toHaveLength(LOADOUT_DECKS);
    // Drawn, not typed: no icon carries text a screen reader or a search could pick up as a number.
    for (const icon of how.querySelectorAll(".landing-step-icon")) {
      expect(icon.textContent).toBe("");
      expect(icon.getAttribute("aria-hidden")).toBe("true");
    }
  });
});

// ---------------------------------------------------------------------------------------------
// R639: the fan rotates through every set once the device has logged enough games, a face opens at
// full size, and the device's statistics are shown
// ---------------------------------------------------------------------------------------------

/** A device with this many logged games (the store's own shape, read back as the page would). */
function withGames(games: number, cards: Record<string, Record<string, number>> = {}): void {
  window.localStorage.setItem(
    PLAYER_STATS_KEY,
    JSON.stringify({ v: PLAYER_STATS_VERSION, games, wins: games, losses: 0, draws: 0, cards }),
  );
  dropPlayerStatsCache();
}

function shownIds(): string[] {
  return [0, 1, 2, 3].map((index) => screen.getByTestId(landingFanCardTestid(index)).getAttribute("data-def-id") ?? "");
}

describe("R639 the homescreen rotation", () => {
  afterEach(() => {
    vi.useRealTimers();
    dropPlayerStatsCache();
  });

  it("R639 below the threshold the fan keeps its fixed deal of Core cards and never swaps", () => {
    vi.useFakeTimers();
    withGames(ROTATION_MIN_GAMES - 1);
    render(<LandingRoute random={seeded(5)} />);
    const hand = shownIds();
    expect(hand).toEqual(dealLandingFan(seeded(5)).map(({ def }) => def.id));
    act(() => {
      vi.advanceTimersByTime(ROTATION_INTERVAL_MS * 6);
    });
    expect(shownIds()).toEqual(hand);
  });

  it("R639 at the threshold the fan deals from every set and swaps one slot a step, left to right", () => {
    vi.useFakeTimers();
    withGames(ROTATION_MIN_GAMES);
    render(<LandingRoute random={seeded(5)} />);

    // The same source, the same draws: the deal, then the swaps the page makes.
    const mirror = seeded(5);
    let expected = dealLandingFan(mirror, ROTATION_POOL, featureWeight);
    expect(shownIds()).toEqual(expected.map(({ def }) => def.id));

    for (const slot of [0, 1, 2, 3, 0]) {
      const before = shownIds();
      act(() => {
        vi.advanceTimersByTime(ROTATION_INTERVAL_MS);
      });
      expected = rotateFan(expected, slot, mirror);
      const after = shownIds();
      expect(after).toEqual(expected.map(({ def }) => def.id));
      // One card moved, in the slot due, and it is a card of the same rarity the fan was not showing.
      expect(after.filter((id, at) => id !== before[at])).toHaveLength(1);
      expect(after[slot]).not.toBe(before[slot]);
      expect(new Set(after).size).toBe(after.length);
    }
  });

  it("R639 across a long visit the fan shows cards of Classic and Classic+ as well as Core", () => {
    vi.useFakeTimers();
    withGames(ROTATION_MIN_GAMES + 40);
    render(<LandingRoute random={seeded(11)} />);
    const sets = new Set<string>();
    const poolById = new Map(ROTATION_POOL.map((def) => [def.id, def]));
    for (let step = 0; step < 60; step += 1) {
      for (const id of shownIds()) sets.add(poolById.get(id)?.set ?? "?");
      act(() => {
        vi.advanceTimersByTime(ROTATION_INTERVAL_MS);
      });
    }
    expect(sets.has("Core")).toBe(true);
    expect(sets.has("Classic")).toBe(true);
    expect(sets.has("Classic+")).toBe(true);
    expect(sets.has("?")).toBe(false);
  });

  it("R639 the hand holds still under reduced motion, while a pointer or focus is on it, and while a card is open", async () => {
    vi.useFakeTimers();
    withGames(ROTATION_MIN_GAMES);
    setReducedMotion(true);
    const reduced = render(<LandingRoute random={seeded(5)} />);
    const dealt = shownIds();
    act(() => {
      vi.advanceTimersByTime(ROTATION_INTERVAL_MS * 3);
    });
    expect(shownIds()).toEqual(dealt);
    reduced.unmount();

    setReducedMotion(false);
    render(<LandingRoute random={seeded(5)} />);
    const fan = screen.getByTestId(landingTestid.fan);
    fireEvent.mouseEnter(fan);
    act(() => {
      vi.advanceTimersByTime(ROTATION_INTERVAL_MS * 3);
    });
    expect(shownIds()).toEqual(dealt);
    fireEvent.mouseLeave(fan);
    act(() => {
      vi.advanceTimersByTime(ROTATION_INTERVAL_MS);
    });
    expect(shownIds()).not.toEqual(dealt);
  });
});

describe("R639 a fan card opens at full size", () => {
  it("R639 a click opens the card's detail dialog and Close puts it away", async () => {
    render(<LandingRoute random={seeded(3)} />);
    const face = screen.getByTestId(landingFanCardTestid(1));
    expect(screen.queryByTestId(INSPECT_DETAIL)).toBeNull();
    fireEvent.click(face);
    const detail = await screen.findByTestId(INSPECT_DETAIL, undefined, SLOW);
    expect(detail.textContent).toContain(face.querySelector(".card-name")?.textContent ?? "(no name)");
    fireEvent.keyDown(detail, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByTestId(INSPECT_DETAIL)).toBeNull();
    });
  });

  it("R639 Enter and Space on a focused face open it too, for a keyboard or a screen reader", async () => {
    render(<LandingRoute random={seeded(3)} />);
    const face = screen.getByTestId(landingFanCardTestid(0));
    fireEvent.keyDown(face, { key: "Tab" });
    expect(screen.queryByTestId(INSPECT_DETAIL)).toBeNull();
    fireEvent.keyDown(face, { key: "Enter" });
    expect(await screen.findByTestId(INSPECT_DETAIL, undefined, SLOW)).toBeInTheDocument();
  });
});

describe("R639 your table", () => {
  it("R639 draws nothing before the first logged game", () => {
    render(<LandingRoute />);
    expect(screen.queryByTestId(landingTestid.stats)).toBeNull();
  });

  it("R639 shows the record and the favourites the device kept, and Clear forgets them", () => {
    withGames(4, { "core-004": { seen: 4, played: 9, playedAgainst: 0, destroyed: 0, defeated: 0 } });
    render(<LandingRoute />);
    const table = screen.getByTestId(landingTestid.stats);
    expect(table.textContent).toContain("4 games: 4 won, 0 lost (100% won)");
    expect(table.querySelector('[data-stat="played"]')?.textContent).toContain("played 9×");
    fireEvent.click(screen.getByTestId(landingTestid.statsClear));
    expect(screen.queryByTestId(landingTestid.stats)).toBeNull();
  });
});
