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
import AccountRoute, { formatWinRate, resetSigningOutForTests, statusWords } from "./account.tsx";

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
  it("wears the tavern frame of the way in, and names a pending account's status in a player's words", () => {
    render(
      <AccountRoute
        token={TOKEN}
        me={{
          profile: { id: "p1", status: "pending", rating: 1000 },
          needsInviteCode: true,
          emailVerified: true,
          currentMatchId: null,
          email: "player1@example.com",
        }}
      />,
    );
    const screenRoot = screen.getByTestId("account-screen");
    expect(screenRoot).toHaveClass("tavern");
    const status = screen.getByTestId("account-status");
    expect(status.textContent).toBe("Waiting for an invite code");
    expect(status.tagName).not.toBe("CODE");
    expect(status).toHaveAttribute("data-status", "pending");
    expect(screen.getByTestId("account-redeem")).toHaveClass("button-primary");
    // Sign-out revokes the session too, and the screen says so.
    expect(screenRoot.textContent).toMatch(/revoked/);
    expect(screenRoot.textContent).not.toMatch(/clears this device.s token/);
  });

  it("says each status in a player's words", () => {
    expect(statusWords("pending")).toBe("Waiting for an invite code");
    expect(statusWords("active")).toBe("Active");
    expect(statusWords("banned")).toBe("Banned");
  });

  it("shows which account you are signed in as, and its record", async () => {
    vi.mocked(getProfile).mockResolvedValue(profileBody());
    render(<AccountRoute token={TOKEN} />);

    // The headline fact: a player could not see this anywhere before.
    expect(await screen.findByTestId("account-email")).toHaveTextContent("player1@example.com");
    // In a player's words, with the raw status beside it for tests.
    expect(screen.getByTestId("account-status")).toHaveTextContent("Active");
    expect(screen.getByTestId("account-status")).toHaveAttribute("data-status", "active");
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

  it("R194 a sign-out that has to wait (an expired session) says so and cannot be pressed again", async () => {
    vi.mocked(getProfile).mockResolvedValue(profileBody());
    vi.stubEnv("VITE_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
    // The renewal sign-out needs before it can revoke never answers here.
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    window.localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ accessToken: TOKEN, refreshToken: "live-refresh", expiresAt: Date.now() - 60_000 }),
    );
    try {
      render(<AccountRoute token={TOKEN} />);
      await screen.findByTestId("account-email");
      const button = screen.getByTestId("account-sign-out");
      await userEvent.click(button);

      expect(button).toHaveTextContent("Signing out…");
      expect(button).toBeDisabled();
      expect(assign, "still waiting on the renewal").not.toHaveBeenCalled();
    } finally {
      resetSigningOutForTests();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });
});
