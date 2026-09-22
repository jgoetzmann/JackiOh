// `/account`: the screen that did not exist, and the three things it has to get right.
//
// Before it, a signed-in player could not see WHICH account they were signed in as, could not see
// their record, and — the one that actually trapped people — could not sign out at all:
// `net/session.ts` wrote the token and nothing ever cleared it.

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getProfile } from "../net/api.ts";
import { SESSION_STORAGE_KEY, readSession } from "../net/session.ts";
import AccountRoute, { formatWinRate } from "./account.tsx";

vi.mock("../net/api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../net/api.ts")>();
  return { ...actual, getProfile: vi.fn() };
});

const TOKEN = "token-1";

function profileBody(over: Partial<Parameters<typeof Object.assign>[0]> = {}) {
  return {
    id: "p1",
    email: "player1@example.com",
    status: "active" as const,
    rating: 1035,
    record: { wins: 7, losses: 2, draws: 1 },
    winRate: 0.7,
    ...over,
  };
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("formatWinRate", () => {
  it("renders a rate as a whole percent", () => {
    expect(formatWinRate(0.7)).toBe("70%");
    expect(formatWinRate(0)).toBe("0%");
    expect(formatWinRate(1)).toBe("100%");
  });

  /** Nothing played is not the same claim as losing everything. */
  it("shows a dash rather than 0% when nothing has been played", () => {
    expect(formatWinRate(null)).toBe("—");
  });
});

describe("the account screen", () => {
  it("shows which account you are signed in as, and its record", async () => {
    vi.mocked(getProfile).mockResolvedValue(profileBody());
    render(<AccountRoute token={TOKEN} />);

    // The headline fact: a player could not see this anywhere before.
    expect(await screen.findByTestId("account-email")).toHaveTextContent("player1@example.com");
    expect(screen.getByTestId("account-status")).toHaveTextContent("active");
    expect(screen.getByTestId("account-rating")).toHaveTextContent("1035");
    expect(screen.getByTestId("account-win-rate")).toHaveTextContent("70%");
    expect(screen.getByTestId("account-record")).toHaveTextContent("7–2–1");
  });

  it("says so plainly when no match has been finished", async () => {
    vi.mocked(getProfile).mockResolvedValue(
      profileBody({ record: { wins: 0, losses: 0, draws: 0 }, winRate: null }),
    );
    render(<AccountRoute token={TOKEN} />);

    expect(await screen.findByTestId("account-win-rate")).toHaveTextContent("—");
    expect(screen.getByText(/no finished matches yet/i)).toBeInTheDocument();
  });

  it("relays a failed read instead of rendering an empty account", async () => {
    vi.mocked(getProfile).mockRejectedValue(new Error("the server refused"));
    render(<AccountRoute token={TOKEN} />);

    expect(await screen.findByTestId("account-error")).toHaveTextContent("the server refused");
  });

  it("signing out clears the stored token", async () => {
    vi.mocked(getProfile).mockResolvedValue(profileBody());
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ accessToken: TOKEN }));
    expect(readSession(), "premise: a session exists").not.toBeNull();

    render(<AccountRoute token={TOKEN} />);
    await screen.findByTestId("account-email");
    await userEvent.click(screen.getByTestId("account-sign-out"));

    await waitFor(() => {
      expect(readSession(), "the token is gone").toBeNull();
    });
  });
});
