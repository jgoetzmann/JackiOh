// `/leaderboard`: Jlorious first, then the tiers, then the Raisins — and never a rating.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getLeaderboard, type LeaderboardResponse } from "../net/api.ts";
import LeaderboardRoute from "./leaderboard.tsx";

vi.mock("../net/api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../net/api.ts")>();
  return { ...actual, getLeaderboard: vi.fn() };
});

const TOKEN = "token-1";

function board(over: Partial<LeaderboardResponse> = {}): LeaderboardResponse {
  return {
    season: "v0.2",
    jlorious: [
      { position: 1, tag: "ABC123", you: false },
      { position: 2, tag: "ME0001", you: true },
    ],
    tiers: [
      { tier: "mythic", count: 0, players: [] },
      { tier: "golden", count: 1, players: [{ tag: "YOU999", division: 1, pips: 2, you: false }] },
      { tier: "large", count: 0, players: [] },
      { tier: "normal", count: 0, players: [] },
      { tier: "rotten", count: 0, players: [] },
    ],
    raisins: 3,
    you: { tier: "jlorious", position: 2 },
    ...over,
  };
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("the leaderboard screen", () => {
  it("lists Jlorious by position, the tiers with their counts, and the Raisins", async () => {
    vi.mocked(getLeaderboard).mockResolvedValue(board());
    render(<LeaderboardRoute token={TOKEN} />);

    expect(await screen.findByTestId("leaderboard-season")).toHaveTextContent("Season v0.2");
    const jlorious = screen.getByTestId("leaderboard-jlorious");
    expect(jlorious.textContent).toMatch(/#1 ABC123/);
    expect(jlorious.textContent).toMatch(/#2 ME0001 \(you\)/);
    const tiers = screen.getAllByTestId("leaderboard-tier");
    expect(tiers).toHaveLength(5);
    expect(tiers[1]?.textContent).toMatch(/Golden Grape \(1\)/);
    expect(tiers[1]?.textContent).toMatch(/YOU999 · Division I · 2 pips/);
    expect(screen.getByTestId("leaderboard-raisins")).toHaveTextContent("3 players are still playing placements.");
    expect(screen.getByTestId("leaderboard-you")).toHaveTextContent("You are Jlorious #2");
  });

  it("says so when Jlorious is empty and nobody is placing", async () => {
    vi.mocked(getLeaderboard).mockResolvedValue(
      board({ jlorious: [], raisins: 0, you: { tier: "raisin", placementsPlayed: 1, placementGames: 5 } }),
    );
    render(<LeaderboardRoute token={TOKEN} />);

    expect(await screen.findByText(/no jlorious players yet/i)).toBeInTheDocument();
    expect(screen.getByTestId("leaderboard-raisins")).toHaveTextContent("Nobody is playing placements right now.");
    expect(screen.getByTestId("leaderboard-you")).toHaveTextContent("You are Raisin · 1/5 placements");
  });

  it("relays a failed read instead of rendering an empty ladder", async () => {
    vi.mocked(getLeaderboard).mockRejectedValue(new Error("the server refused"));
    render(<LeaderboardRoute token={TOKEN} />);

    expect(await screen.findByTestId("leaderboard-error")).toHaveTextContent("the server refused");
  });
});
