// `/login`: the password reveal, and the mode toggle it shares a screen with.
//
// The reveal matters most while CREATING a password: a value you cannot read is a value you
// cannot check before submitting, and getting it wrong there costs an email round trip.

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import LoginRoute from "./login.tsx";

afterEach(cleanup);

describe("the password reveal", () => {
  it("starts hidden", () => {
    render(<LoginRoute />);
    expect(screen.getByTestId("login-password")).toHaveAttribute("type", "password");
  });

  it("reveals and re-hides the password, and says which it is doing", async () => {
    render(<LoginRoute />);
    const field = screen.getByTestId("login-password");
    const toggle = screen.getByTestId("login-toggle-password");

    // Announced, not just drawn: the label is what a screen reader has to go on.
    expect(toggle).toHaveAttribute("aria-label", "Show password");
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(toggle);
    expect(field).toHaveAttribute("type", "text");
    expect(toggle).toHaveAttribute("aria-label", "Hide password");
    expect(toggle).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(toggle);
    expect(field).toHaveAttribute("type", "password");
  });

  it("keeps what was typed when the password is revealed", async () => {
    render(<LoginRoute />);
    const field = screen.getByTestId("login-password");
    await userEvent.type(field, "hunter22222");
    await userEvent.click(screen.getByTestId("login-toggle-password"));

    expect(field).toHaveValue("hunter22222");
  });

  /** The reveal has to survive the switch, since sign-up is where it earns its keep. */
  it("is available when creating an account, not only when signing in", async () => {
    render(<LoginRoute />);
    await userEvent.click(screen.getByTestId("login-mode"));

    expect(screen.getByTestId("login-password")).toHaveAttribute("autocomplete", "new-password");
    expect(screen.getByTestId("login-toggle-password")).toBeInTheDocument();
  });
});
