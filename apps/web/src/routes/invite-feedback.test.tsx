// The code screen's feedback (docs/polish/5-sign-in.md, B20-B23): when submit is allowed, how many
// tries are left, a rate limit shown as a rate limit (R192, never R145's identical error), and a
// way out of the screen in every state.
//
// `../net/api.ts` is mocked the way invite.test.tsx mocks it, so the three reads are whatever each
// test says the server answered. Every server sentence is either imported from config or is a stub
// this file invents to stand for "whatever the server wrote", which the screen must show verbatim.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CODE_ALPHABET,
  CODE_ATTEMPT_WINDOW_SECONDS,
  INVITE_CODE_GROUP_SIZE,
  INVITE_CODE_LENGTH,
  INVITE_CODE_SEPARATOR,
  REDEMPTION_IDENTICAL_ERROR,
} from "../../../server/src/config.ts";
import { attemptsText, waitInWords } from "../auth/codeInput.ts";
import { AUTH_NOTICES } from "../net/auth.ts";
import { inviteTestid, shellTestid } from "../auth/testids.ts";
import {
  ApiRequestError,
  ApiUnreachableError,
  getCodeStatus,
  getMe,
  redeemCode,
  retryAfterMsOf,
  type CodeStatusResponse,
} from "../net/api.ts";
import { paths } from "../net/navigate.ts";
import { E2E_SESSION_STORAGE_KEY, SESSION_STORAGE_KEY } from "../net/session.ts";
import InviteRoute from "./invite.tsx";
import { navTestid } from "./nav.tsx";

vi.mock("../net/api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../net/api.ts")>();
  return {
    ...actual,
    getMe: vi.fn(),
    getCodeStatus: vi.fn(),
    redeemCode: vi.fn(),
  };
});

const TOKEN = "e2e-token-pending";
const EMAIL = "player@example.test";

/** A stand-in for whatever sentence the server's 429 carries. The screen must relay it verbatim. */
const SERVER_RATE_SENTENCE = "Too many attempts. Wait, then try again. (stubbed server sentence)";

/** The redemption window the server states as the wait (R192's upper bound). */
const WINDOW_MS = CODE_ATTEMPT_WINDOW_SECONDS * 1000;

const LETTERS = CODE_ALPHABET.replace(/[0-9]/g, "");
const FULL = LETTERS.slice(0, INVITE_CODE_LENGTH);

function grouped(characters: string): string {
  const groups: string[] = [];
  for (let index = 0; index < characters.length; index += INVITE_CODE_GROUP_SIZE) {
    groups.push(characters.slice(index, index + INVITE_CODE_GROUP_SIZE));
  }
  return groups.join(INVITE_CODE_SEPARATOR);
}

const GOOD = grouped(FULL);
/** Another complete code, for a second try: a refused code is never sent again unchanged. */
const OTHER = grouped(LETTERS.slice(LETTERS.length - INVITE_CODE_LENGTH));

function meBody(status: "pending" | "active", needsInviteCode: boolean) {
  return {
    profile: { id: "p", status, rating: 1000 },
    needsInviteCode,
    emailVerified: true,
    currentMatchId: null,
    email: EMAIL,
  };
}

function status(over: Partial<CodeStatusResponse> = {}): CodeStatusResponse {
  return { redemptionEnabled: true, retryAfterMs: 0, attemptsRemaining: 5, ...over };
}

function rateLimited(retryAfterMs = WINDOW_MS): ApiRequestError {
  return new ApiRequestError(429, {
    code: "rate_limited",
    message: SERVER_RATE_SENTENCE,
    details: { retryAfterMs },
  });
}

function invalidCode(): ApiRequestError {
  return new ApiRequestError(400, { code: "invalid_code", message: REDEMPTION_IDENTICAL_ERROR });
}

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(E2E_SESSION_STORAGE_KEY, JSON.stringify({ accessToken: TOKEN }));
  window.history.replaceState(null, "", "/invite");
  vi.mocked(getMe).mockResolvedValue(meBody("pending", true));
  vi.mocked(getCodeStatus).mockResolvedValue(status());
  vi.mocked(redeemCode).mockReset();
  // Sign-out revokes at the provider; nothing here may reach a real network.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>(() => {})),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function mount(): Promise<void> {
  render(<InviteRoute />);
  await waitFor(() => {
    expect(getCodeStatus).toHaveBeenCalled();
  });
  await screen.findByTestId(inviteTestid.input);
}

function input(): HTMLElement {
  return screen.getByTestId(inviteTestid.input);
}

function submit(): HTMLElement {
  return screen.getByTestId(inviteTestid.submit);
}

function fill(value: string): void {
  fireEvent.change(input(), { target: { value } });
}

// ---------------------------------------------------------------------------------------------
// B20: when submit is allowed, and what it sends
// ---------------------------------------------------------------------------------------------

describe("B20 submit", () => {
  it("B20 is disabled for an empty and a partial code, and enabled once complete", async () => {
    await mount();
    expect(submit()).toBeDisabled();

    fill(FULL.slice(0, INVITE_CODE_LENGTH - 1));
    expect(submit()).toBeDisabled();

    fill(FULL);
    await waitFor(() => {
      expect(submit()).toBeEnabled();
    });
  });

  it("B20 a partial code costs no attempt: clicking does not redeem", async () => {
    await mount();
    fill(FULL.slice(0, INVITE_CODE_GROUP_SIZE));
    fireEvent.click(submit());
    expect(redeemCode).not.toHaveBeenCalled();
  });

  it("B20 a code with an excluded character never becomes submittable", async () => {
    await mount();
    fill(grouped(`${FULL.slice(0, INVITE_CODE_LENGTH - 1)}0`));
    expect(submit()).toBeDisabled();
    fireEvent.click(submit());
    expect(redeemCode).not.toHaveBeenCalled();
  });

  it("B20 is disabled while redemption is paused, even with a complete code", async () => {
    vi.mocked(getCodeStatus).mockResolvedValue(status({ redemptionEnabled: false, retryAfterMs: 60_000 }));
    await mount();
    await screen.findByTestId(inviteTestid.paused);
    fill(GOOD);
    expect(submit()).toBeDisabled();
    fireEvent.click(submit());
    expect(redeemCode).not.toHaveBeenCalled();
  });

  it("B20 is disabled when attemptsRemaining is 0", async () => {
    vi.mocked(getCodeStatus).mockResolvedValue(status({ attemptsRemaining: 0 }));
    await mount();
    await waitFor(() => {
      expect(screen.getByTestId(inviteTestid.attempts)).toHaveAttribute("data-remaining", "0");
    });
    fill(GOOD);
    expect(submit()).toBeDisabled();
    fireEvent.click(submit());
    expect(redeemCode).not.toHaveBeenCalled();
  });

  it("B20 is enabled with one attempt left", async () => {
    vi.mocked(getCodeStatus).mockResolvedValue(status({ attemptsRemaining: 1 }));
    await mount();
    await waitFor(() => {
      expect(screen.getByTestId(inviteTestid.attempts)).toHaveAttribute("data-remaining", "1");
    });
    fill(GOOD);
    expect(submit()).toBeEnabled();
  });

  it("B20 is enabled against a server that reports no attempt count", async () => {
    vi.mocked(getCodeStatus).mockResolvedValue({ redemptionEnabled: true, retryAfterMs: 0 });
    await mount();
    fill(GOOD);
    await waitFor(() => {
      expect(submit()).toBeEnabled();
    });
  });

  it("B20 is disabled while a redemption is in flight, so a double click sends one", async () => {
    vi.mocked(redeemCode).mockReturnValue(new Promise(() => {}));
    await mount();
    fill(GOOD);
    fireEvent.click(submit());
    await waitFor(() => {
      expect(submit()).toBeDisabled();
    });
    fireEvent.click(submit());
    expect(redeemCode).toHaveBeenCalledTimes(1);
  });

  it("B20 sends exactly the formatted code, whatever form it was typed in", async () => {
    vi.mocked(redeemCode).mockResolvedValue({ status: "active", needsInviteCode: false });
    await mount();
    fill(` ${GOOD.toLowerCase().split(INVITE_CODE_SEPARATOR).join(" ")} `);
    expect(input()).toHaveValue(GOOD);
    fireEvent.click(submit());
    await waitFor(() => {
      expect(redeemCode).toHaveBeenCalledWith(TOKEN, GOOD);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// B21: tries left
// ---------------------------------------------------------------------------------------------

describe("B21 tries left", () => {
  it.each([[5], [3], [1], [0]] as const)(
    "B21 shows %i tries left from /api/codes/status in invite-attempts",
    async (remaining) => {
      vi.mocked(getCodeStatus).mockResolvedValue(status({ attemptsRemaining: remaining }));
      await mount();
      const attempts = await screen.findByTestId(inviteTestid.attempts);
      await waitFor(() => {
        expect(attempts).toHaveAttribute("data-remaining", String(remaining));
      });
      expect(attempts.textContent).toContain(attemptsText(remaining));
    },
  );

  it("B21 reads the status again after an invalid_code refusal", async () => {
    vi.mocked(getCodeStatus)
      .mockResolvedValueOnce(status({ attemptsRemaining: 5 }))
      .mockResolvedValue(status({ attemptsRemaining: 4 }));
    vi.mocked(redeemCode).mockRejectedValue(invalidCode());
    await mount();
    await waitFor(() => {
      expect(screen.getByTestId(inviteTestid.attempts)).toHaveAttribute("data-remaining", "5");
    });

    fill(GOOD);
    fireEvent.click(submit());

    await waitFor(() => {
      expect(screen.getByTestId(inviteTestid.attempts)).toHaveAttribute("data-remaining", "4");
    });
    expect(screen.getByTestId(inviteTestid.attempts).textContent).toContain(attemptsText(4));
  });

  it("B21 reads the status again after every refusal, not only the first", async () => {
    vi.mocked(getCodeStatus)
      .mockResolvedValueOnce(status({ attemptsRemaining: 3 }))
      .mockResolvedValueOnce(status({ attemptsRemaining: 2 }))
      .mockResolvedValue(status({ attemptsRemaining: 1 }));
    vi.mocked(redeemCode).mockRejectedValue(invalidCode());
    await mount();

    fill(GOOD);
    fireEvent.click(submit());
    await waitFor(() => {
      expect(screen.getByTestId(inviteTestid.attempts)).toHaveAttribute("data-remaining", "2");
    });

    // A refused code is never sent again unchanged (R145), so the second try is another code.
    fill(OTHER);
    await waitFor(() => {
      expect(submit()).toBeEnabled();
    });
    fireEvent.click(submit());
    await waitFor(() => {
      expect(screen.getByTestId(inviteTestid.attempts)).toHaveAttribute("data-remaining", "1");
    });
  });

  it("B21 reads the status again after a rate-limited refusal, and hides the count while the wait stands", async () => {
    vi.mocked(getCodeStatus)
      .mockResolvedValueOnce(status({ attemptsRemaining: 2 }))
      .mockResolvedValue(status({ attemptsRemaining: 0 }));
    vi.mocked(redeemCode).mockRejectedValue(rateLimited());
    await mount();
    fill(GOOD);
    fireEvent.click(submit());
    await screen.findByTestId(inviteTestid.rateLimited);
    await waitFor(() => {
      expect(getCodeStatus).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByTestId(inviteTestid.attempts)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// B22 / R192: a rate limit is a rate limit
// ---------------------------------------------------------------------------------------------

describe("B22 a rate-limited redemption", () => {
  it("B22 shows the server's sentence verbatim, the wait, and disables submit", async () => {
    vi.mocked(redeemCode).mockRejectedValue(rateLimited(WINDOW_MS));
    await mount();
    fill(GOOD);
    fireEvent.click(submit());

    const error = await screen.findByTestId(inviteTestid.error);
    expect(error.textContent).toBe(SERVER_RATE_SENTENCE);
    expect(error.textContent).not.toBe(REDEMPTION_IDENTICAL_ERROR);

    const panel = await screen.findByTestId(inviteTestid.rateLimited);
    expect(panel).toHaveAttribute("data-retry-after-ms", String(WINDOW_MS));
    expect(submit()).toBeDisabled();
    expect(document.body.textContent).not.toContain(REDEMPTION_IDENTICAL_ERROR);
  });

  it("B22 a second click while rate limited sends nothing", async () => {
    vi.mocked(redeemCode).mockRejectedValue(rateLimited(WINDOW_MS));
    await mount();
    fill(GOOD);
    fireEvent.click(submit());
    await screen.findByTestId(inviteTestid.rateLimited);
    fireEvent.click(submit());
    expect(redeemCode).toHaveBeenCalledTimes(1);
  });

  it("B22 an invalid_code refusal is still R145's identical sentence, with no rate-limit panel", async () => {
    vi.mocked(redeemCode).mockRejectedValue(invalidCode());
    await mount();
    fill(GOOD);
    fireEvent.click(submit());

    const error = await screen.findByTestId(inviteTestid.error);
    expect(error.textContent).toBe(REDEMPTION_IDENTICAL_ERROR);
    expect(screen.queryByTestId(inviteTestid.rateLimited)).toBeNull();
  });

  describe("retryAfterMsOf", () => {
    it("B22 reads details.retryAfterMs off a rate_limited refusal", () => {
      expect(retryAfterMsOf(rateLimited(WINDOW_MS))).toBe(WINDOW_MS);
      expect(retryAfterMsOf(rateLimited(0))).toBe(0);
    });

    it("B22 is null for a refusal that is not rate_limited", () => {
      expect(retryAfterMsOf(invalidCode())).toBeNull();
      expect(
        retryAfterMsOf(
          new ApiRequestError(503, {
            code: "unavailable",
            message: "paused",
            details: { retryAfterMs: WINDOW_MS },
          }),
        ),
      ).toBeNull();
    });

    it("B22 is null for a rate_limited refusal with no numeric wait", () => {
      expect(
        retryAfterMsOf(new ApiRequestError(429, { code: "rate_limited", message: SERVER_RATE_SENTENCE })),
      ).toBeNull();
      expect(
        retryAfterMsOf(
          new ApiRequestError(429, {
            code: "rate_limited",
            message: SERVER_RATE_SENTENCE,
            details: { retryAfterMs: "soon" },
          }),
        ),
      ).toBeNull();
    });

    it("B22 is null for anything that is not an ApiRequestError", () => {
      expect(retryAfterMsOf(new Error("rate_limited"))).toBeNull();
      expect(retryAfterMsOf({ code: "rate_limited", details: { retryAfterMs: 5 } })).toBeNull();
      expect(retryAfterMsOf(null)).toBeNull();
      expect(retryAfterMsOf(undefined)).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------------------------
// B23: always a way out
// ---------------------------------------------------------------------------------------------

describe("B23 the way out", () => {
  const states: readonly (readonly [string, () => void])[] = [
    ["a pending account with redemption open", () => {}],
    [
      "a pending account while redemption is paused",
      () => {
        vi.mocked(getCodeStatus).mockResolvedValue(
          status({ redemptionEnabled: false, retryAfterMs: 60_000 }),
        );
      },
    ],
    [
      "a pending account with no tries left",
      () => {
        vi.mocked(getCodeStatus).mockResolvedValue(status({ attemptsRemaining: 0 }));
      },
    ],
    [
      "an active account that needs no code",
      () => {
        vi.mocked(getMe).mockResolvedValue(meBody("active", false));
      },
    ],
  ];

  it.each(states)("B23 %s is offered nav-back, the account's email and sign-out", async (_name, arrange) => {
    arrange();
    render(<InviteRoute />);
    expect(await screen.findByTestId(navTestid.back)).toBeInTheDocument();
    expect(await screen.findByTestId(inviteTestid.accountEmail)).toHaveTextContent(EMAIL);
    expect(await screen.findByTestId(inviteTestid.signOut)).toBeInTheDocument();
  });

  it("B23 the way out stays after a rate-limited refusal", async () => {
    vi.mocked(redeemCode).mockRejectedValue(rateLimited());
    await mount();
    fill(GOOD);
    fireEvent.click(submit());
    await screen.findByTestId(inviteTestid.rateLimited);
    expect(screen.getByTestId(navTestid.back)).toBeInTheDocument();
    expect(screen.getByTestId(inviteTestid.signOut)).toBeEnabled();
  });

  it("B23 says where a code comes from, and offers Play vs AI, which needs none, for the meantime", async () => {
    await mount();
    const where = await screen.findByTestId(inviteTestid.whereFrom);
    expect(where.textContent).toMatch(/invite-only/);
    // In a player's words: who hands codes out, not a note about servers.
    expect(where.textContent).toMatch(/JackiOh team/);
    expect(where.textContent).not.toMatch(/server/);
    expect(screen.getByTestId(inviteTestid.playAi)).toHaveAttribute("href", paths.practice);
    fireEvent.click(screen.getByTestId(inviteTestid.playAi));
    expect(window.location.pathname).toBe(paths.practice);
  });

  it("B21 a status re-read that fails keeps the last status: 'No tries left' is not forgotten", async () => {
    vi.mocked(getCodeStatus).mockResolvedValueOnce(status({ attemptsRemaining: 0 }));
    vi.mocked(getCodeStatus).mockRejectedValue(new TypeError("Failed to fetch"));
    vi.mocked(redeemCode).mockRejectedValue(invalidCode());
    await mount();
    expect(await screen.findByTestId(inviteTestid.attempts)).toHaveAttribute("data-remaining", "0");
    fill(GOOD);
    expect(submit()).toBeDisabled();
    await flushMicrotasks();
    expect(screen.getByTestId(inviteTestid.attempts)).toHaveAttribute("data-remaining", "0");
    expect(submit()).toBeDisabled();
  });

  it("B23 signing out clears both session keys", async () => {
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ accessToken: TOKEN }));
    await mount();
    fireEvent.click(await screen.findByTestId(inviteTestid.signOut));
    await waitFor(() => {
      expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
      expect(window.localStorage.getItem(E2E_SESSION_STORAGE_KEY)).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------------------------
// B23: sign-out lands on `/`. `signOut` does a real page load (`window.location.assign`), which
// jsdom cannot follow, so the test swaps `location` for a copy whose `assign` records where it was
// sent and what storage held at that moment. The swap happens after the screen has mounted, so
// nothing else on the screen reads the copy.
// ---------------------------------------------------------------------------------------------

describe("B23 signing out lands on the landing page", () => {
  it("B23 invite-sign-out loads / once both session keys are gone", async () => {
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ accessToken: TOKEN }));
    await mount();

    const loads: { to: string; session: string | null; e2eSession: string | null }[] = [];
    const assign = vi.fn((to: string | URL) => {
      loads.push({
        to: String(to),
        session: window.localStorage.getItem(SESSION_STORAGE_KEY),
        e2eSession: window.localStorage.getItem(E2E_SESSION_STORAGE_KEY),
      });
    });
    vi.stubGlobal("location", { ...window.location, assign });

    fireEvent.click(screen.getByTestId(inviteTestid.signOut));

    expect(loads).toEqual([{ to: paths.landing, session: null, e2eSession: null }]);
  });

  it("B23 invite-sign-out still lands on / after a rate-limited refusal", async () => {
    vi.mocked(redeemCode).mockRejectedValue(rateLimited());
    await mount();
    fill(GOOD);
    fireEvent.click(submit());
    await screen.findByTestId(inviteTestid.rateLimited);

    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    fireEvent.click(screen.getByTestId(inviteTestid.signOut));

    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(paths.landing);
  });
});

// ---------------------------------------------------------------------------------------------
// The adversarial panel's findings
// ---------------------------------------------------------------------------------------------

/** Settle promise chains without touching timers. */
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
  });
}

describe("R192 a stated wait lifts by itself", () => {
  it("R192 no tries left says how long to wait, reads the status again when it runs out, and submit comes back", async () => {
    // The waits are deadlines on the clock, so the clock moves with the timers.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    try {
      const wait = 17 * 60_000;
      vi.mocked(getCodeStatus)
        .mockResolvedValueOnce(status({ attemptsRemaining: 0, attemptsRetryAfterMs: wait }))
        .mockResolvedValue(status({ attemptsRemaining: 1, attemptsRetryAfterMs: 0 }));
      render(<InviteRoute />);
      await flushMicrotasks();
      fill(GOOD);

      const attempts = screen.getByTestId(inviteTestid.attempts);
      expect(attempts.textContent).toBe(attemptsText(0, wait));
      expect(attempts.textContent).toContain(waitInWords(wait));
      expect(submit()).toBeDisabled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(wait);
      });
      await flushMicrotasks();

      expect(getCodeStatus).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId(inviteTestid.attempts)).toHaveAttribute("data-remaining", "1");
      expect(submit()).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("R192 paused redemption says how long, and lifts when the breaker's wait is over", async () => {
    // The waits are deadlines on the clock, so the clock moves with the timers.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    try {
      const wait = 5 * 60_000;
      vi.mocked(getCodeStatus)
        .mockResolvedValueOnce(status({ redemptionEnabled: false, retryAfterMs: wait }))
        .mockResolvedValue(status());
      render(<InviteRoute />);
      await flushMicrotasks();
      fill(GOOD);

      expect(screen.getByTestId(inviteTestid.paused).textContent).toContain(waitInWords(wait));
      expect(submit()).toBeDisabled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(wait);
      });
      await flushMicrotasks();

      expect(screen.queryByTestId(inviteTestid.paused)).toBeNull();
      expect(submit()).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("R192 a per-IP refusal on a shared network", () => {
  it("R192 never shows a full count of tries beside the wait, and blames no one", async () => {
    // Step 3 (per IP) refused; this account's own count is untouched and the status still says 6.
    vi.mocked(getCodeStatus).mockResolvedValue(status({ attemptsRemaining: 6 }));
    vi.mocked(redeemCode).mockRejectedValue(rateLimited(WINDOW_MS));
    await mount();
    fill(GOOD);
    fireEvent.click(submit());

    const panel = await screen.findByTestId(inviteTestid.rateLimited);
    await waitFor(() => {
      expect(getCodeStatus).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByTestId(inviteTestid.attempts)).toBeNull();
    expect(panel.textContent).toMatch(/account or network/);
    expect(panel.textContent).not.toMatch(/You’ve tried/);
  });
});

describe("B20 the Redeem button while a redemption is in flight", () => {
  it("B20 says it is working", async () => {
    vi.mocked(redeemCode).mockReturnValue(new Promise(() => {}));
    await mount();
    fill(GOOD);
    fireEvent.click(submit());
    expect(submit()).toBeDisabled();
    expect(submit().textContent).toBe("Redeeming…");
  });
});

describe("B22 the identical error once the code has changed", () => {
  it("B22 goes away when the player edits the code, but a rate limit's wait stays", async () => {
    vi.mocked(redeemCode).mockRejectedValueOnce(invalidCode()).mockRejectedValueOnce(rateLimited());
    await mount();
    fill(GOOD);
    fireEvent.click(submit());
    await screen.findByTestId(inviteTestid.error);
    fill(GOOD.slice(0, -1));
    expect(screen.queryByTestId(inviteTestid.error)).toBeNull();

    fill(OTHER);
    await waitFor(() => {
      expect(submit()).toBeEnabled();
    });
    fireEvent.click(submit());
    await screen.findByTestId(inviteTestid.rateLimited);
    fill(OTHER.slice(0, -1));
    expect(screen.getByTestId(inviteTestid.error).textContent).toBe(SERVER_RATE_SENTENCE);
    expect(screen.getByTestId(inviteTestid.rateLimited)).toBeInTheDocument();
  });
});

describe("an active account on the code screen", () => {
  it("is offered the way on instead of a Redeem button and a count of tries", async () => {
    vi.mocked(getMe).mockResolvedValue(meBody("active", false));
    vi.mocked(getCodeStatus).mockResolvedValue(status({ attemptsRemaining: 6 }));
    render(<InviteRoute />);

    await screen.findByTestId(inviteTestid.notNeeded);
    await flushMicrotasks();
    expect(screen.queryByTestId(inviteTestid.submit)).toBeNull();
    expect(screen.queryByTestId(inviteTestid.input)).toBeNull();
    expect(screen.queryByTestId(inviteTestid.attempts)).toBeNull();
    const onward = screen.getByTestId(inviteTestid.goToDecks);
    expect(onward).toHaveAttribute("href", paths.decks);
    // The title says there is nothing to enter, rather than asking for a code.
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("You\u2019re all set");
    fireEvent.click(onward);
    expect(window.location.pathname).toBe(paths.decks);
  });

  it("a redemption refused because another tab already redeemed reads the account again and moves on", async () => {
    let activeElsewhere = false;
    vi.mocked(getMe).mockImplementation(async () =>
      activeElsewhere ? meBody("active", false) : meBody("pending", true),
    );
    vi.mocked(redeemCode).mockRejectedValue(
      new ApiRequestError(409, { code: "conflict", message: "This account is already active." }),
    );
    await mount();
    activeElsewhere = true;
    fill(GOOD);
    fireEvent.click(submit());

    // R145: the account-state sentence is shown as the server wrote it...
    expect((await screen.findByTestId(inviteTestid.error)).textContent).toBe("This account is already active.");
    // ...and the screen reads the account again and offers the way on.
    await screen.findByTestId(inviteTestid.goToDecks);
    expect(screen.queryByTestId(inviteTestid.submit)).toBeNull();
  });
});

describe("R194 a redemption the API refuses as unauthorised", () => {
  const URL_ = "https://project.supabase.co";

  function providerAnswer(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    } as unknown as Response;
  }

  function signedInWithRefresh(refreshAnswer: { status: number; body: unknown }): string[] {
    vi.stubEnv("VITE_SUPABASE_URL", URL_);
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
    window.localStorage.clear();
    window.localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ accessToken: "old", refreshToken: "r-old", expiresAt: Date.now() + 2 * 3_600_000 }),
    );
    const refreshes: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown) => {
        const url = String(input);
        if (url.includes("grant_type=refresh_token")) {
          refreshes.push(url);
          return Promise.resolve(providerAnswer(refreshAnswer.status, refreshAnswer.body));
        }
        return new Promise<Response>(() => {});
      }),
    );
    return refreshes;
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("R194 renews the session once and sends the redemption again with the new token", async () => {
    const refreshes = signedInWithRefresh({
      status: 200,
      body: { access_token: "new", refresh_token: "r-new", expires_at: 2_000_000_000 },
    });
    vi.mocked(redeemCode).mockImplementation(async (token) => {
      if (token === "old") throw new ApiRequestError(401, { code: "unauthorized", message: "sign in first" });
      return { status: "active", needsInviteCode: false };
    });
    await mount();
    fill(GOOD);
    fireEvent.click(submit());

    await screen.findByTestId(inviteTestid.redeemed);
    expect(vi.mocked(redeemCode).mock.calls.map(([token]) => token)).toEqual(["old", "new"]);
    expect(refreshes).toHaveLength(1);
    expect(JSON.parse(window.localStorage.getItem(SESSION_STORAGE_KEY) ?? "{}").accessToken).toBe("new");
    expect(screen.queryByText("sign in first")).toBeNull();
  });

  it("R194 a renewal the provider refuses ends the session and says so on the sign-in screen", async () => {
    signedInWithRefresh({ status: 400, body: { error_code: "refresh_token_not_found" } });
    vi.mocked(redeemCode).mockRejectedValue(new ApiRequestError(401, { code: "unauthorized", message: "sign in first" }));
    await mount();
    fill(GOOD);
    fireEvent.click(submit());

    await waitFor(() => {
      expect(`${window.location.pathname}${window.location.search}`).toBe(`${paths.login}?reason=expired`);
    });
    expect(redeemCode).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// R145: a refused code is not sent again unchanged, and the answer is about the code on screen
// ---------------------------------------------------------------------------------------------

describe("R145 a code the server refused", () => {
  it("R145 is not sent again unchanged: Redeem stays off and says why until the code is changed", async () => {
    vi.mocked(redeemCode).mockRejectedValue(invalidCode());
    await mount();
    fill(GOOD);
    fireEvent.click(submit());
    expect((await screen.findByTestId(inviteTestid.error)).textContent).toBe(REDEMPTION_IDENTICAL_ERROR);
    await waitFor(() => {
      expect(submit()).toHaveAttribute("aria-busy", "false");
    });

    // Pressing again ("maybe it didn't take") spends nothing: the same code cannot turn good.
    expect(submit()).toBeDisabled();
    expect(screen.getByTestId(inviteTestid.refused).textContent).toMatch(/Change the code to try again/);
    for (let press = 0; press < 3; press += 1) {
      fireEvent.click(submit());
      await flushMicrotasks();
    }
    expect(vi.mocked(redeemCode).mock.calls.map((call) => call[1])).toEqual([GOOD]);
    // The caret is back in the field, where the fix goes.
    expect(document.activeElement).toBe(input());

    // Edited and edited back: still the refused code, still off.
    fill(GOOD.slice(0, -1));
    fill(GOOD);
    expect(submit()).toBeDisabled();
    expect(screen.getByTestId(inviteTestid.refused)).toBeInTheDocument();

    // Another code is a new try.
    fill(OTHER);
    expect(submit()).toBeEnabled();
    expect(screen.queryByTestId(inviteTestid.refused)).toBeNull();
    fireEvent.click(submit());
    await waitFor(() => {
      expect(vi.mocked(redeemCode).mock.calls.map((call) => call[1])).toEqual([GOOD, OTHER]);
    });
  });

  it("R145 a rate limit or another refusal does not mark the code: it may be tried again once allowed", async () => {
    vi.mocked(redeemCode)
      .mockRejectedValueOnce(new ApiRequestError(503, { code: "unavailable", message: "try later" }))
      .mockRejectedValue(invalidCode());
    await mount();
    fill(GOOD);
    fireEvent.click(submit());
    await screen.findByTestId(inviteTestid.error);
    await waitFor(() => {
      expect(submit()).toBeEnabled();
    });
    expect(screen.queryByTestId(inviteTestid.refused)).toBeNull();
  });

  it("R145 the field is locked while a code is being redeemed, so the refusal is about the code on screen", async () => {
    let refuse: (error: unknown) => void = () => undefined;
    vi.mocked(redeemCode).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          refuse = reject;
        }),
    );
    await mount();
    fill(GOOD);
    fireEvent.click(submit());
    await waitFor(() => {
      expect(submit()).toHaveTextContent("Redeeming…");
    });
    expect(input()).toBeDisabled();

    // An edit that somehow arrives meanwhile (a synthetic event) is ignored by the locked field.
    fill(OTHER);
    expect(input()).toHaveValue(GOOD);

    await act(async () => {
      refuse(invalidCode());
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(submit()).toHaveAttribute("aria-busy", "false");
    });
    expect(input()).toBeEnabled();
    expect(input()).toHaveValue(GOOD);
    expect(screen.getByTestId(inviteTestid.error).textContent).toBe(REDEMPTION_IDENTICAL_ERROR);
  });
});

// ---------------------------------------------------------------------------------------------
// §9.4 step 1: an unconfirmed email has a way forward on the code screen
// ---------------------------------------------------------------------------------------------

describe("an account whose email is not confirmed yet", () => {
  const UNVERIFIED_SENTENCE = "Verify your email address before redeeming an invite code.";

  function unverifiedMe() {
    return { ...meBody("pending", true), emailVerified: false };
  }

  function providerStub(): string[] {
    vi.stubEnv("VITE_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === "/auth/v1/resend") {
          sent.push(typeof init?.body === "string" ? init.body : "");
          return Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
        }
        return new Promise<Response>(() => {});
      }),
    );
    return sent;
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("says so above the form, resends the confirmation to the account's address, and checks again", async () => {
    const sent = providerStub();
    vi.mocked(getMe).mockResolvedValue(unverifiedMe());
    await mount();

    const panel = await screen.findByTestId(inviteTestid.unverified);
    expect(panel.textContent).toContain(EMAIL);
    fireEvent.click(screen.getByTestId(inviteTestid.resend));
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(JSON.parse(sent[0] ?? "{}")).toEqual({ type: "signup", email: EMAIL });
    expect((await screen.findByTestId(inviteTestid.resendNotice)).textContent).toBe(AUTH_NOTICES.resendSent);
    // R192: the provider's interval for that address is waited out before it is offered again.
    expect(screen.getByTestId(inviteTestid.resend)).toBeDisabled();

    // Confirmed in the mail app; "Check again" reads the account again and the panel goes.
    vi.mocked(getMe).mockResolvedValue(meBody("pending", true));
    const reads = vi.mocked(getMe).mock.calls.length;
    fireEvent.click(screen.getByTestId(inviteTestid.checkAgain));
    await waitFor(() => {
      expect(vi.mocked(getMe).mock.calls.length).toBeGreaterThan(reads);
    });
    await waitFor(() => {
      expect(screen.queryByTestId(inviteTestid.unverified)).toBeNull();
    });
  });

  it("an email_unverified refusal (the server could not confirm it) shows the same way forward", async () => {
    providerStub();
    vi.mocked(redeemCode).mockRejectedValue(
      new ApiRequestError(403, { code: "email_unverified", message: UNVERIFIED_SENTENCE }),
    );
    await mount();
    expect(screen.queryByTestId(inviteTestid.unverified)).toBeNull();
    fill(GOOD);
    fireEvent.click(submit());

    expect((await screen.findByTestId(inviteTestid.error)).textContent).toBe(UNVERIFIED_SENTENCE);
    expect(await screen.findByTestId(inviteTestid.unverified)).toBeInTheDocument();
    expect(screen.getByTestId(inviteTestid.resend)).toBeEnabled();
    expect(screen.getByTestId(inviteTestid.checkAgain)).toBeEnabled();
    // Not a code refusal: the same code may be sent again once the email is confirmed.
    await waitFor(() => {
      expect(submit()).toBeEnabled();
    });
  });
});

// ---------------------------------------------------------------------------------------------
// One account's state: the screen starts again for another account
// ---------------------------------------------------------------------------------------------

describe("the code screen's state belongs to one account", () => {
  function me(id: string, email: string) {
    return {
      profile: { id, status: "pending" as const, rating: 1000 },
      needsInviteCode: true,
      emailVerified: true,
      currentMatchId: null,
      email,
    };
  }

  it("a device that moves from A to B does not keep A's rate limit, refusal or typed code", async () => {
    vi.mocked(getCodeStatus).mockResolvedValue(status({ attemptsRemaining: 1 }));
    vi.mocked(redeemCode).mockRejectedValueOnce(rateLimited());

    // What `<Gated>` renders for /invite: the same InviteRoute, handed the gate's account.
    const { rerender } = render(<InviteRoute account={{ token: "token-a", me: me("a", "a@example.test") }} />);
    fireEvent.change(await screen.findByTestId(inviteTestid.input), { target: { value: GOOD } });
    await waitFor(() => {
      expect(submit()).toBeEnabled();
    });
    fireEvent.click(submit());
    await screen.findByTestId(inviteTestid.rateLimited);

    // Another tab signs B in over A; the gate hands B to the same screen.
    vi.mocked(getCodeStatus).mockResolvedValue(status({ attemptsRemaining: 6 }));
    await act(async () => {
      rerender(<InviteRoute account={{ token: "token-b", me: me("b", "b@example.test") }} />);
    });
    await waitFor(() => {
      expect(screen.getByTestId(inviteTestid.accountEmail)).toHaveTextContent("b@example.test");
    });
    await waitFor(() => {
      expect(getCodeStatus).toHaveBeenLastCalledWith("token-b");
    });
    expect(screen.queryByTestId(inviteTestid.rateLimited)).toBeNull();
    expect(screen.queryByTestId(inviteTestid.error)).toBeNull();
    expect(screen.getByTestId(inviteTestid.input)).toHaveValue("");
  });
});

// ---------------------------------------------------------------------------------------------
// The third panel round: stated waits are deadlines, a 503 is a pause, "Check again" answers
// ---------------------------------------------------------------------------------------------

const MINUTE = 60_000;

describe("R192 a stated wait is read from the clock", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("R192 'No tries left' counts down: half an hour into a 42-minute wait it says about 12 minutes", async () => {
    // The clock stands still between the read and the check, so the minutes come out exact.
    const start = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(start);
    vi.mocked(getCodeStatus).mockResolvedValue(status({ attemptsRemaining: 0, attemptsRetryAfterMs: 42 * MINUTE }));
    render(<InviteRoute />);
    expect((await screen.findByTestId(inviteTestid.attempts)).textContent).toBe(attemptsText(0, 42 * MINUTE));

    vi.spyOn(Date, "now").mockReturnValue(start + 30 * MINUTE);
    // Any re-render (here a keystroke) reads the clock again.
    fill("AB");
    expect(screen.getByTestId(inviteTestid.attempts).textContent).toBe(attemptsText(0, 12 * MINUTE));
  });

  it("R192 a page shown again after the wait has passed reads the status at once, not when a frozen timer fires", async () => {
    const start = Date.now();
    vi.mocked(getCodeStatus)
      .mockResolvedValueOnce(status({ attemptsRemaining: 0, attemptsRetryAfterMs: 42 * MINUTE }))
      .mockResolvedValue(status({ attemptsRemaining: 1, attemptsRetryAfterMs: 0 }));
    render(<InviteRoute />);
    await screen.findByTestId(inviteTestid.attempts);
    fill(GOOD);
    expect(submit()).toBeDisabled();

    // The phone slept with the tab in the background and is unlocked after the wait.
    vi.spyOn(Date, "now").mockReturnValue(start + 43 * MINUTE);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() => {
      expect(getCodeStatus).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(submit()).toBeEnabled();
    });
    expect(screen.getByTestId(inviteTestid.attempts)).toHaveAttribute("data-remaining", "1");
  });

  it("R192 the rate-limited panel's wait counts down, and lifts on waking once it has passed", async () => {
    const start = Date.now();
    vi.mocked(redeemCode).mockRejectedValue(rateLimited(WINDOW_MS));
    await mount();
    fill(GOOD);
    vi.spyOn(Date, "now").mockReturnValue(start);
    fireEvent.click(submit());
    const panel = await screen.findByTestId(inviteTestid.rateLimited);
    expect(panel.textContent).toContain(waitInWords(WINDOW_MS));
    // The stated wait is kept as the server said it.
    expect(panel).toHaveAttribute("data-retry-after-ms", String(WINDOW_MS));

    vi.spyOn(Date, "now").mockReturnValue(start + WINDOW_MS - 10 * MINUTE);
    fill(OTHER);
    expect(screen.getByTestId(inviteTestid.rateLimited).textContent).toContain(waitInWords(10 * MINUTE));

    vi.spyOn(Date, "now").mockReturnValue(start + WINDOW_MS + MINUTE);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => {
      expect(screen.queryByTestId(inviteTestid.rateLimited)).toBeNull();
    });
    expect(submit()).toBeEnabled();
  });
});

describe("R192 a 503 from a redemption is a pause", () => {
  it("R192 Redeem goes off at once, and the status read after it says for how long", async () => {
    let answerStatus: (value: CodeStatusResponse) => void = () => undefined;
    vi.mocked(getCodeStatus)
      .mockResolvedValueOnce(status())
      // The read after the refusal is slow (a sleeping server): the pause must not wait for it.
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answerStatus = resolve;
          }),
      );
    vi.mocked(redeemCode).mockRejectedValue(
      new ApiRequestError(503, { code: "unavailable", message: "Invite redemption is temporarily unavailable." }),
    );
    await mount();
    fill(GOOD);
    fireEvent.click(submit());

    expect(await screen.findByTestId(inviteTestid.paused)).toBeInTheDocument();
    await waitFor(() => {
      expect(getCodeStatus).toHaveBeenCalledTimes(2);
    });
    // Off before the status read answers, so a second press cannot spend another try.
    expect(submit()).toBeDisabled();
    fireEvent.click(submit());
    expect(redeemCode).toHaveBeenCalledTimes(1);

    await act(async () => {
      answerStatus(status({ redemptionEnabled: false, retryAfterMs: 5 * MINUTE }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByTestId(inviteTestid.paused).textContent).toContain(waitInWords(5 * MINUTE));
    });
    expect(submit()).toBeDisabled();
  });
});

describe("'Check again' on an unconfirmed email answers", () => {
  function unverifiedMe() {
    return { ...meBody("pending", true), emailVerified: false };
  }

  it("says it is checking, then says so when the email is still unconfirmed", async () => {
    vi.mocked(getMe).mockResolvedValue(unverifiedMe());
    await mount();
    await screen.findByTestId(inviteTestid.unverified);

    let answer: (value: ReturnType<typeof unverifiedMe>) => void = () => undefined;
    vi.mocked(getMe).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    fireEvent.click(screen.getByTestId(inviteTestid.checkAgain));
    expect(screen.getByTestId(inviteTestid.checkAgain)).toHaveTextContent("Checking…");
    expect(screen.getByTestId(inviteTestid.checkAgain)).toBeDisabled();

    await act(async () => {
      answer(unverifiedMe());
      await Promise.resolve();
    });
    const result = await screen.findByTestId(inviteTestid.checkResult);
    expect(result).toHaveAttribute("data-result", "unchanged");
    expect(result.textContent).toMatch(/Still not confirmed/);
    expect(screen.getByTestId(inviteTestid.checkAgain)).toBeEnabled();
  });

  it("a check that cannot reach the server says so, and the code screen and the typed code stay", async () => {
    const { App } = await import("../main.tsx");
    vi.mocked(getMe)
      .mockResolvedValueOnce(unverifiedMe())
      .mockRejectedValue(new ApiUnreachableError(new TypeError("Failed to fetch")));
    render(<App />);
    await screen.findByTestId(inviteTestid.checkAgain);
    const partial = grouped(FULL.slice(0, 12));
    fill(partial);

    fireEvent.click(screen.getByTestId(inviteTestid.checkAgain));

    expect(await screen.findByTestId(inviteTestid.checkResult)).toHaveAttribute("data-result", "failed");
    expect(screen.queryByTestId(shellTestid.error)).toBeNull();
    expect(input()).toHaveValue(partial);
  });

  it("a check that finds the email confirmed takes the notice away and tells the gate", async () => {
    vi.mocked(getMe).mockResolvedValueOnce(unverifiedMe()).mockResolvedValue(meBody("pending", true));
    const announced = vi.fn();
    window.addEventListener("jackioh:account-changed", announced);
    try {
      await mount();
      await screen.findByTestId(inviteTestid.unverified);
      fireEvent.click(screen.getByTestId(inviteTestid.checkAgain));
      await waitFor(() => {
        expect(screen.queryByTestId(inviteTestid.unverified)).toBeNull();
      });
      expect(announced).toHaveBeenCalled();
    } finally {
      window.removeEventListener("jackioh:account-changed", announced);
    }
  });
});
