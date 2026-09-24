// A screen whose code fails to load (docs/polish/5-sign-in.md, B40). Every route but the landing
// page is a lazy chunk; on a flaky network, and after every deploy for a tab left open, the import
// fails. The whole root used to unmount to a blank page. Now the failed screen shows a panel with a
// reload and a real link home, and moving to another screen clears it.

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clearConsumedAuthRedirect } from "../auth/redirect.ts";
import { shellTestid } from "../auth/testids.ts";
import { navigate, paths } from "../net/navigate.ts";

vi.mock("./login.tsx", () => {
  throw new TypeError("Failed to fetch dynamically imported module: /assets/login-3f9a.js");
});

const { App } = await import("../main.tsx");

afterEach(() => {
  cleanup();
  clearConsumedAuthRedirect();
  vi.restoreAllMocks();
});

describe("B40 a screen that fails to load", () => {
  it("B40 shows a panel with a reload and a real link home instead of a blank page", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    window.history.replaceState(null, "", paths.login);
    render(<App />);

    const panel = await screen.findByTestId(shellTestid.loadFailed);
    expect(panel.textContent).toMatch(/didn’t load/);
    expect(screen.getByTestId(shellTestid.reload)).toBeInTheDocument();
    // A real link, not an in-app move: a fresh page load fetches the current build.
    expect(screen.getByTestId(shellTestid.loadFailedHome)).toHaveAttribute("href", paths.landing);
  });

  it("B40 moving to another screen clears the panel", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    window.history.replaceState(null, "", paths.login);
    render(<App />);
    await screen.findByTestId(shellTestid.loadFailed);

    act(() => {
      navigate(paths.landing);
    });
    expect(screen.queryByTestId(shellTestid.loadFailed)).toBeNull();
  });
});

describe("R193 an emailed link on /login whose screen fails to load", () => {
  it("R193 its tokens are gone from the address bar at the first render, and stay gone after the failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fragment = new URLSearchParams({
      access_token: "header.payload.signature",
      refresh_token: "live-refresh-token-from-the-email",
      expires_in: "3600",
      token_type: "bearer",
      type: "signup",
    });
    window.history.replaceState(null, "", `${paths.login}#${fragment.toString()}`);
    render(<App />);

    // The first render: the login chunk has not run (it never will), and the boot scrub has.
    expect(window.location.href).not.toContain("refresh_token");

    await screen.findByTestId(shellTestid.loadFailed);
    // "Reload" reloads this very URL, which must not carry the tokens.
    expect(window.location.href).not.toContain("live-refresh-token-from-the-email");
    expect(window.location.pathname).toBe(paths.login);
  });
});
