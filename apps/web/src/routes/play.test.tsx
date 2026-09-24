// `/play`'s match watch: the two moments a player ends up paired without being told.
//
// Only one side's HTTP response ever carries the match id, so the other side has to read its own
// `currentMatchId`. That matters while WAITING in the lobby, and again on a RELOAD after being
// paired — the second loses the waiting flag with the page, and was a dead end until the check
// was moved to run on every mount.

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getMe } from "../net/api.ts";
import { navigate, paths } from "../net/navigate.ts";
import PlayRoute, { playTestid } from "./play.tsx";

vi.mock("../net/api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../net/api.ts")>();
  return {
    ...actual,
    getMe: vi.fn(),
    enqueue: vi.fn(),
    dequeue: vi.fn(),
    createRoom: vi.fn(),
    joinRoom: vi.fn(),
  };
});
vi.mock("../net/navigate.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../net/navigate.ts")>();
  return { ...actual, navigate: vi.fn() };
});

const TOKEN = "token-1";

function me(currentMatchId: string | null) {
  return {
    profile: { id: "p1", status: "active" as const, rating: 1000 },
    needsInviteCode: false,
    emailVerified: true,
    currentMatchId,
    email: "player1@example.com",
  };
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("the lobby's match watch", () => {
  /**
   * The reload case. `waiting` is component state, so a refresh clears it; before the check ran on
   * mount, this player sat in the lobby while their opponent was already on the board.
   */
  it("sends an already-paired player to the board on mount, without queueing again", async () => {
    vi.mocked(getMe).mockResolvedValue(me("match-42"));
    render(<PlayRoute token={TOKEN} />);

    await waitFor(() => {
      expect(vi.mocked(navigate)).toHaveBeenCalledWith("/match/match-42");
    });
  });

  it("leaves a player who is in no match exactly where they are", async () => {
    vi.mocked(getMe).mockResolvedValue(me(null));
    render(<PlayRoute token={TOKEN} />);

    await waitFor(() => {
      expect(vi.mocked(getMe)).toHaveBeenCalled();
    });
    expect(vi.mocked(navigate)).not.toHaveBeenCalled();
  });

  /** A lobby that cannot reach the server is still a lobby, not an error screen. */
  it("ignores a failed read rather than surfacing it as a lobby error", async () => {
    vi.mocked(getMe).mockRejectedValue(new Error("network down"));
    render(<PlayRoute token={TOKEN} />);

    await waitFor(() => {
      expect(vi.mocked(getMe)).toHaveBeenCalled();
    });
    expect(vi.mocked(navigate)).not.toHaveBeenCalled();
  });
});

describe("the lobby's way to practice", () => {
  /** /practice needs no account; the lobby links it so a player can find it without typing the URL. */
  it("links to /practice", async () => {
    vi.mocked(getMe).mockResolvedValue(me(null));
    const { getByTestId } = render(<PlayRoute token={TOKEN} />);

    expect(getByTestId(playTestid.practice)).toHaveAttribute("href", paths.practice);
    expect(paths.practice).toBe("/practice");
    await waitFor(() => {
      expect(vi.mocked(getMe)).toHaveBeenCalled();
    });
  });
});
