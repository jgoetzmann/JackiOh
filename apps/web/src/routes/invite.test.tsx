// BUILD M8's row for `10-invite-gate.cy.ts`: "code screen shown; bad code error identical for
// three failure kinds; good code activates".
//
// The three states the screen can be in, plus the property that makes the identical error worth
// anything: §9.4's one sentence for a code failure and R145's distinct sentence for an
// account-state failure both reach the DOM exactly as the server wrote them. A client that
// paraphrased either would flatten the two into one, which is the oracle §9.8 is paying 80 bits to
// avoid. Every number in the format assertions is imported from `apps/server/src/config.ts`.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CODE_ALPHABET,
  INVITE_CODE_GROUP_SIZE,
  INVITE_CODE_LENGTH,
  INVITE_CODE_SEPARATOR,
  REDEMPTION_IDENTICAL_ERROR,
} from "../../../server/src/config.ts";
import { ApiRequestError, getCodeStatus, getMe, redeemCode } from "../net/api.ts";
import { E2E_SESSION_STORAGE_KEY } from "../net/session.ts";
import InviteRoute, {
  INVITE_CODE_INPUT,
  INVITE_CODE_PLACEHOLDER,
  INVITE_ERROR,
  INVITE_NOT_NEEDED,
  INVITE_PAUSED,
  INVITE_SUBMIT,
  formatInviteCode,
  inviteCodeCharacters,
} from "./invite.tsx";

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

/** A well-formed code over R104's alphabet, built rather than spelled. */
const GOOD_CODE = formatInviteCode(
  Array.from({ length: INVITE_CODE_LENGTH }, (_unused, index) =>
    CODE_ALPHABET[index % CODE_ALPHABET.length],
  ).join(""),
);

function meBody(status: "pending" | "active", needsInviteCode: boolean) {
  return {
    profile: { id: "p", status, rating: 1000 },
    needsInviteCode,
    emailVerified: true,
    currentMatchId: null,
    email: "player@example.test",
  };
}

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(E2E_SESSION_STORAGE_KEY, JSON.stringify({ accessToken: TOKEN }));
  window.history.replaceState(null, "", "/invite");
  vi.mocked(getMe).mockResolvedValue(meBody("pending", true));
  vi.mocked(getCodeStatus).mockResolvedValue({ redemptionEnabled: true, retryAfterMs: 0 });
  vi.mocked(redeemCode).mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function mount(): Promise<void> {
  render(<InviteRoute />);
  await waitFor(() => {
    expect(getCodeStatus).toHaveBeenCalled();
  });
}

// ---------------------------------------------------------------------------------------------
// §9.4's format, from config
// ---------------------------------------------------------------------------------------------

describe("the code format is §9.4's, read from apps/server/src/config.ts", () => {
  it("normalises to upper case and keeps only the alphabet (R104)", () => {
    // R104: "the alphabet is uppercase-only, so SPEC's exclusion of lowercase `l` is satisfied by
    // normalising any user-entered code to upper case before comparison, rather than by omitting a
    // lowercase `l` that could never appear here in the first place." So `0`, `O`, `1` and `I` are
    // dropped (none is in `CODE_ALPHABET`) while a typed `l` becomes the alphabet's own `L` — the
    // ruling's words, not an accident of this function.
    expect(inviteCodeCharacters("abcd")).toBe("ABCD");
    expect(inviteCodeCharacters("A0O1I B")).toBe("AB");
    expect(inviteCodeCharacters("l")).toBe("L");
    for (const excluded of ["0", "O", "1", "I"]) {
      expect(CODE_ALPHABET.includes(excluded), `${excluded} is outside R104's alphabet`).toBe(false);
    }
    expect(CODE_ALPHABET.includes("L"), "R104 keeps L; SPEC excludes only lowercase l").toBe(true);
  });

  it("groups the characters the way §9.4 formats them", () => {
    const bare = Array.from({ length: INVITE_CODE_LENGTH }, () => "A").join("");
    const formatted = formatInviteCode(bare);
    const groups = formatted.split(INVITE_CODE_SEPARATOR);
    expect(groups).toHaveLength(INVITE_CODE_LENGTH / INVITE_CODE_GROUP_SIZE);
    for (const group of groups) expect(group).toHaveLength(INVITE_CODE_GROUP_SIZE);
  });

  it("never accepts more than INVITE_CODE_LENGTH characters", () => {
    const tooLong = Array.from({ length: INVITE_CODE_LENGTH * 2 }, () => "A").join("");
    expect(inviteCodeCharacters(tooLong)).toHaveLength(INVITE_CODE_LENGTH);
  });

  it("builds its placeholder from the constants rather than spelling the format", () => {
    expect(INVITE_CODE_PLACEHOLDER.split(INVITE_CODE_SEPARATOR)).toHaveLength(
      INVITE_CODE_LENGTH / INVITE_CODE_GROUP_SIZE,
    );
    expect(INVITE_CODE_PLACEHOLDER.replaceAll(INVITE_CODE_SEPARATOR, "")).toHaveLength(
      INVITE_CODE_LENGTH,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// state 1: a pending account, redemption open
// ---------------------------------------------------------------------------------------------

describe("a pending account", () => {
  it("is shown the code screen", async () => {
    await mount();
    expect(screen.getByTestId(INVITE_CODE_INPUT)).toBeInTheDocument();
    expect(screen.getByTestId(INVITE_SUBMIT)).toBeInTheDocument();
    expect(screen.queryByTestId(INVITE_PAUSED)).toBeNull();
    expect(screen.queryByTestId(INVITE_NOT_NEEDED)).toBeNull();
    expect(window.location.pathname).toBe("/invite");
  });

  it("formats what is typed, and submits exactly what the box shows", async () => {
    vi.mocked(redeemCode).mockResolvedValue({ status: "active", needsInviteCode: false });
    await mount();

    const input = screen.getByTestId(INVITE_CODE_INPUT);
    fireEvent.change(input, { target: { value: GOOD_CODE.toLowerCase() } });
    expect(input).toHaveValue(GOOD_CODE);

    fireEvent.click(screen.getByTestId(INVITE_SUBMIT));
    await waitFor(() => {
      expect(redeemCode).toHaveBeenCalledWith(TOKEN, GOOD_CODE);
    });
  });

  it("goes to the deckbuilder once the code is redeemed", async () => {
    vi.mocked(redeemCode).mockResolvedValue({ status: "active", needsInviteCode: false });
    await mount();
    fireEvent.change(screen.getByTestId(INVITE_CODE_INPUT), { target: { value: GOOD_CODE } });
    fireEvent.click(screen.getByTestId(INVITE_SUBMIT));
    await waitFor(() => {
      expect(window.location.pathname).toBe("/decks");
    });
  });

  it("does not submit an empty box", async () => {
    await mount();
    expect(screen.getByTestId(INVITE_SUBMIT)).toBeDisabled();
    fireEvent.click(screen.getByTestId(INVITE_SUBMIT));
    expect(redeemCode).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
// the error, verbatim (§9.4's identical error and R145's distinct one)
// ---------------------------------------------------------------------------------------------

describe("a refusal is rendered exactly as the server wrote it", () => {
  async function submitAndFail(error: ApiRequestError): Promise<HTMLElement> {
    vi.mocked(redeemCode).mockRejectedValue(error);
    await mount();
    fireEvent.change(screen.getByTestId(INVITE_CODE_INPUT), { target: { value: GOOD_CODE } });
    fireEvent.click(screen.getByTestId(INVITE_SUBMIT));
    return waitFor(() => screen.getByTestId(INVITE_ERROR));
  }

  it("shows §9.4's one sentence for a code failure, character for character", async () => {
    const node = await submitAndFail(
      new ApiRequestError(400, { code: "invalid_code", message: REDEMPTION_IDENTICAL_ERROR }),
    );
    expect(node.textContent).toBe(REDEMPTION_IDENTICAL_ERROR);
  });

  it("shows an account-state refusal as its own sentence, not as the code one (R145)", async () => {
    // §9.4's identical error covers missing, revoked, expired, exhausted and malformed. An
    // already-active account is a 409 and is *supposed* to read differently; the client must not
    // level the two.
    const distinct = "This account is already active.";
    const node = await submitAndFail(
      new ApiRequestError(409, { code: "already_active", message: distinct }),
    );
    expect(node.textContent).toBe(distinct);
    expect(node.textContent).not.toBe(REDEMPTION_IDENTICAL_ERROR);
  });

  it("shows a transport failure's own message rather than inventing one", async () => {
    const node = await submitAndFail(
      new ApiRequestError(503, { code: "unavailable", message: "service unavailable" }),
    );
    expect(node.textContent).toBe("service unavailable");
  });
});

// ---------------------------------------------------------------------------------------------
// state 2: redemption paused (§9.4's circuit breaker)
// ---------------------------------------------------------------------------------------------

describe("when redemption is paused", () => {
  it("says so from GET /api/codes/status instead of guessing after a 503", async () => {
    vi.mocked(getCodeStatus).mockResolvedValue({ redemptionEnabled: false, retryAfterMs: 60_000 });
    await mount();
    await waitFor(() => {
      expect(screen.getByTestId(INVITE_PAUSED)).toBeInTheDocument();
    });
    expect(screen.getByTestId(INVITE_PAUSED)).toHaveAttribute("data-retry-after-ms", "60000");
    expect(screen.getByTestId(INVITE_SUBMIT)).toBeDisabled();
  });

  it("still takes a code when the status read itself failed", async () => {
    vi.mocked(getCodeStatus).mockRejectedValue(new Error("no status"));
    render(<InviteRoute />);
    await waitFor(() => {
      expect(screen.getByTestId(INVITE_CODE_INPUT)).toBeInTheDocument();
    });
    expect(screen.queryByTestId(INVITE_PAUSED)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// state 3: an active account that reached the code screen
// ---------------------------------------------------------------------------------------------

describe("an active account", () => {
  it("is told it needs no code, and the route stays reachable", async () => {
    vi.mocked(getMe).mockResolvedValue(meBody("active", false));
    await mount();
    await waitFor(() => {
      expect(screen.getByTestId(INVITE_NOT_NEEDED)).toBeInTheDocument();
    });
    // Spec 10 visits this route while pending and expects to stay; nothing bounces an active one
    // away either, because redemption is the pending → active transition and 409 is not a gate.
    expect(window.location.pathname).toBe("/invite");
  });
});

// ---------------------------------------------------------------------------------------------
// no session at all
// ---------------------------------------------------------------------------------------------

describe("with no session", () => {
  it("goes to the sign-in screen", async () => {
    window.localStorage.clear();
    render(<InviteRoute />);
    await waitFor(() => {
      expect(window.location.pathname).toBe("/login");
    });
    expect(getMe).not.toHaveBeenCalled();
  });
});
