// The segmented invite-code field (docs/polish/5-sign-in.md, B15-B19), and R191's promise that the
// client reads a code exactly as the server does.
//
// The field is one real <input> drawn as four groups. Everything asserted here is what a player
// or a screen reader can observe: the input's value and caret, the segments' `data-state`, the
// progress line and the hint. The shared table `CODE_INPUT_CASES` is the same one the server's
// parity test redeems, so a row the server accepts is a row this field fills, character for
// character.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { findCodeInText, type CodeInputProblem } from "@jackioh/shared";

import {
  CODE_ALPHABET,
  CODE_ATTEMPT_WINDOW_SECONDS,
  INVITE_CODE_FORMAT,
  INVITE_CODE_GROUP_SIZE,
  INVITE_CODE_LENGTH,
  INVITE_CODE_SEPARATOR,
} from "../../../server/src/config.ts";
import {
  CODE_INPUT_CASES,
  type CodeInputCase,
} from "../../../../packages/shared/test/fixtures/code-input-cases.ts";
import CodeField from "./CodeField.tsx";
import {
  INVITE_CODE_GROUPS,
  INVITE_CODE_PLACEHOLDER,
  codeProblemMessage,
  codeProgressText,
  pastedText,
  waitInWords,
} from "./codeInput.ts";
import { codeFieldSegmentTestid, codeFieldTestid, inviteTestid } from "./testids.ts";

afterEach(cleanup);

// ---------------------------------------------------------------------------------------------
// fixtures, built from config rather than spelled
// ---------------------------------------------------------------------------------------------

const G = INVITE_CODE_GROUP_SIZE;

/** R104's letters only, so a code built from them reads the same in any font. */
const LETTERS = CODE_ALPHABET.replace(/[0-9]/g, "");

/** A complete code: the first INVITE_CODE_LENGTH letters of the alphabet. */
const FULL = LETTERS.slice(0, INVITE_CODE_LENGTH);

/** ASCII [0-9A-Z] minus the alphabet: R104's 0, 1, I and O, computed here, not imported. */
const EXCLUDED = [..."0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"].filter(
  (character) => !CODE_ALPHABET.includes(character),
);

/** `characters` in groups of INVITE_CODE_GROUP_SIZE, joined by the separator, none trailing. */
function grouped(characters: string): string {
  const groups: string[] = [];
  for (let index = 0; index < characters.length; index += G) {
    groups.push(characters.slice(index, index + G));
  }
  return groups.join(INVITE_CODE_SEPARATOR);
}

/** The Surface's caret formula: n + (n > 0 ? floor((n - 1) / groupSize) : 0). */
function caretAfter(characterCount: number): number {
  return characterCount + (characterCount > 0 ? Math.floor((characterCount - 1) / G) : 0);
}

type Change = { formatted: string; complete: boolean };

type HarnessProps = {
  initial?: string;
  describedBy?: string;
  disabled?: boolean;
  testId?: string;
  log?: Change[];
};

/** `CodeField` is controlled; this is the smallest parent that owns its value. */
function Harness({ initial = "", describedBy, disabled, testId, log }: HarnessProps): ReactElement {
  const [value, setValue] = useState(initial);
  return (
    <div>
      <label htmlFor="invite-code">Invite code</label>
      <CodeField
        id="invite-code"
        value={value}
        describedBy={describedBy}
        disabled={disabled}
        testId={testId}
        onChange={(next) => {
          log?.push(next);
          setValue(next.formatted);
        }}
      />
    </div>
  );
}

function field(): HTMLInputElement {
  return screen.getByTestId(inviteTestid.input) as HTMLInputElement;
}

function root(): HTMLElement {
  return screen.getByTestId(codeFieldTestid.root);
}

function hint(): HTMLElement | null {
  return screen.queryByTestId(codeFieldTestid.hint);
}

function segment(index: number): HTMLElement {
  return screen.getByTestId(codeFieldSegmentTestid(index));
}

function progress(): HTMLElement {
  return screen.getByTestId(codeFieldTestid.progress);
}

/** A paste as the browser delivers it. Returns false when the handler called preventDefault. */
function paste(input: HTMLElement, text: string): boolean {
  return fireEvent.paste(input, {
    clipboardData: { getData: () => text, types: ["text/plain"] },
  });
}

/** A raw edit with the caret where the browser would leave it. */
function changeAt(input: HTMLElement, raw: string, caret: number): void {
  fireEvent.change(input, { target: { value: raw, selectionStart: caret, selectionEnd: caret } });
}

function problemOf(row: CodeInputCase): CodeInputProblem {
  if (row.problem === "tooLong") return { kind: "tooLong" };
  expect(row.character, `${row.name}: an ${String(row.problem)} row names its character`).toBeDefined();
  if (row.problem === "excluded") return { kind: "excluded", character: row.character ?? "" };
  return { kind: "foreign", character: row.character ?? "" };
}

/** ASCII letters and digits in `text`: more than a code's worth is a message, not a mistyped code. */
function letterAndDigitCount(text: string): number {
  return [...text.normalize("NFKC")].filter((character) => /^[0-9A-Za-z]$/.test(character)).length;
}

/** The code a paste of this row fills the field with. */
function codeFilledBy(row: CodeInputCase): string {
  const code = row.canonical ?? findCodeInText(row.input, INVITE_CODE_FORMAT);
  expect(code, `${row.name}: premise, the row names a code`).not.toBeNull();
  return code ?? "";
}

/** B17: a valid row, or one whose text holds exactly one code, is taken by the paste handler. */
const FILLED_BY_PASTE = CODE_INPUT_CASES.filter((row) => row.canonical !== null || row.foundInText);
/** The rest go through to the field's own reading, exactly as a keystroke would. */
const READ_CLEAN = CODE_INPUT_CASES.filter(
  (row) => row.canonical === null && !row.foundInText && row.problem === null,
);
const READ_WITH_PROBLEM = CODE_INPUT_CASES.filter(
  (row) => row.canonical === null && !row.foundInText && row.problem !== null,
);

// ---------------------------------------------------------------------------------------------
// the table is not empty (a table-driven suite over nothing would pass)
// ---------------------------------------------------------------------------------------------

describe("the shared table", () => {
  it("R191 B17 has rows the paste handler fills and rows of each problem kind", () => {
    expect(FILLED_BY_PASTE.length).toBeGreaterThan(0);
    expect(READ_CLEAN.length, "the 15-character row: incomplete, no problem").toBeGreaterThan(0);
    for (const kind of ["excluded", "foreign", "tooLong"] as const) {
      expect(
        CODE_INPUT_CASES.some((row) => row.problem === kind),
        `a row with problem ${kind}`,
      ).toBe(true);
    }
    // Premise for every fixture below.
    expect(LETTERS.length).toBeGreaterThanOrEqual(INVITE_CODE_LENGTH);
    expect(EXCLUDED.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
// B15: one input, four segments, a progress line
// ---------------------------------------------------------------------------------------------

describe("B15 the field's DOM", () => {
  it("B15 is one text input with the invite testid, no maxLength, and the input attributes", () => {
    const { container } = render(<Harness />);
    expect(screen.getAllByTestId(inviteTestid.input)).toHaveLength(1);
    expect(container.querySelectorAll("input")).toHaveLength(1);

    const input = field();
    expect(input.hasAttribute("maxlength"), "no maxLength: a padded paste must not be cut").toBe(false);
    expect(input).toHaveAttribute("type", "text");
    expect(input).toHaveAttribute("inputmode", "text");
    expect(input).toHaveAttribute("autocomplete", "off");
    expect(input).toHaveAttribute("autocapitalize", "characters");
    expect(input).toHaveAttribute("autocorrect", "off");
    expect(input).toHaveAttribute("spellcheck", "false");
    expect(input).toHaveAttribute("placeholder", INVITE_CODE_PLACEHOLDER);
    expect(input).toHaveValue("");
  });

  it("B15 is labelled through its id, and sits inside div.code-field", () => {
    render(<Harness />);
    expect(screen.getByLabelText("Invite code")).toBe(field());
    const host = root();
    expect(host.tagName).toBe("DIV");
    expect(host).toHaveClass("code-field");
    expect(host).toContainElement(field());
    expect(host).toHaveAttribute("data-complete", "false");
    expect(host).not.toHaveAttribute("data-problem");
  });

  it("B15 draws INVITE_CODE_GROUPS aria-hidden segments, all empty, and no hint", () => {
    render(<Harness />);
    expect(INVITE_CODE_GROUPS).toBe(INVITE_CODE_LENGTH / G);
    for (let index = 0; index < INVITE_CODE_GROUPS; index += 1) {
      const part = segment(index);
      expect(part).toHaveAttribute("aria-hidden", "true");
      expect(part).toHaveAttribute("data-state", "empty");
      expect(["true", "false"]).toContain(part.getAttribute("data-active"));
    }
    expect(screen.queryByTestId(codeFieldSegmentTestid(INVITE_CODE_GROUPS))).toBeNull();
    expect(hint()).toBeNull();
  });

  it("B15 reads 0 of 16 characters in a polite live region", () => {
    render(<Harness />);
    const line = progress();
    expect(line.tagName).toBe("P");
    expect(line).toHaveAttribute("aria-live", "polite");
    expect(line.textContent).toContain(`0 of ${String(INVITE_CODE_LENGTH)}`);
  });

  it("B15 segments go empty, partial, complete as the groups fill, and progress counts", () => {
    render(<Harness />);
    const input = field();

    fireEvent.change(input, { target: { value: FULL.slice(0, 2) } });
    expect(segment(0)).toHaveAttribute("data-state", "partial");
    expect(segment(1)).toHaveAttribute("data-state", "empty");
    expect(progress().textContent).toContain(`2 of ${String(INVITE_CODE_LENGTH)}`);

    fireEvent.change(input, { target: { value: FULL.slice(0, G) } });
    expect(segment(0)).toHaveAttribute("data-state", "complete");
    expect(segment(1)).toHaveAttribute("data-state", "empty");

    fireEvent.change(input, { target: { value: FULL.slice(0, G + 2) } });
    expect(segment(0)).toHaveAttribute("data-state", "complete");
    expect(segment(1)).toHaveAttribute("data-state", "partial");
    expect(progress().textContent).toContain(`${String(G + 2)} of ${String(INVITE_CODE_LENGTH)}`);
    expect(root()).toHaveAttribute("data-complete", "false");

    fireEvent.change(input, { target: { value: FULL } });
    for (let index = 0; index < INVITE_CODE_GROUPS; index += 1) {
      expect(segment(index)).toHaveAttribute("data-state", "complete");
    }
    expect(root()).toHaveAttribute("data-complete", "true");
    expect(progress().textContent).toContain(
      `${String(INVITE_CODE_LENGTH)} of ${String(INVITE_CODE_LENGTH)}`,
    );
  });

  it("B15 progress text is codeProgressText of what the field holds", () => {
    const log: Change[] = [];
    render(<Harness log={log} />);
    fireEvent.change(field(), { target: { value: FULL.slice(0, 5) } });
    expect(field()).toHaveValue(grouped(FULL.slice(0, 5)));
    expect(progress().textContent).toContain(`5 of ${String(INVITE_CODE_LENGTH)}`);
    expect(progress().textContent).toBe(
      codeProgressText({
        characters: FULL.slice(0, 5),
        formatted: grouped(FULL.slice(0, 5)),
        complete: false,
        problem: null,
      }),
    );
  });

  it("B15 reports complete to its parent only when every character is in", () => {
    const log: Change[] = [];
    render(<Harness log={log} />);
    fireEvent.change(field(), { target: { value: FULL.slice(0, INVITE_CODE_LENGTH - 1) } });
    expect(log.at(-1)).toEqual({ formatted: grouped(FULL.slice(0, INVITE_CODE_LENGTH - 1)), complete: false });
    fireEvent.change(field(), { target: { value: FULL } });
    expect(log.at(-1)).toEqual({ formatted: grouped(FULL), complete: true });
  });

  it("B15 honours testId, disabled and describedBy", () => {
    render(<Harness testId="room-code-input" disabled describedBy="extra-help" />);
    expect(screen.queryByTestId(inviteTestid.input)).toBeNull();
    const input = screen.getByTestId("room-code-input");
    expect(input).toBeDisabled();
    const ids = (input.getAttribute("aria-describedby") ?? "").split(/\s+/);
    expect(ids).toContain("extra-help");
  });
});

// ---------------------------------------------------------------------------------------------
// B16: typing upper-cases and groups; the caret follows
// ---------------------------------------------------------------------------------------------

describe("B16 typing", () => {
  it("B16 typing abcdefgh shows ABCD-EFGH with the caret at the end", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = field();

    await user.type(input, "abcd");
    // No trailing separator: the group is full but nothing follows it yet.
    expect(input).toHaveValue(grouped("ABCD"));

    await user.type(input, "efgh");
    expect(input).toHaveValue(grouped("ABCDEFGH"));
    expect(input.value.charAt(G)).toBe(INVITE_CODE_SEPARATOR);
    await waitFor(() => {
      expect(input.selectionStart).toBe(input.value.length);
      expect(input.selectionEnd).toBe(input.value.length);
    });
  });

  it("B16 the separator appears when the first character of the next group is typed", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = field();
    await user.type(input, "abcde");
    expect(input).toHaveValue(`ABCD${INVITE_CODE_SEPARATOR}E`);
    await waitFor(() => {
      expect(input.selectionStart).toBe(caretAfter(G + 1));
    });
  });

  it("B16 a character typed mid-code lands where it was typed and the caret follows it", async () => {
    render(<Harness initial={grouped(FULL.slice(0, 2 * G))} />);
    const input = field();
    // "AB|CD-EFGH" + X  ->  raw "ABXCD-EFGH" with the caret after the X.
    const raw = `${FULL.slice(0, 2)}X${FULL.slice(2, G)}${INVITE_CODE_SEPARATOR}${FULL.slice(G, 2 * G)}`;
    changeAt(input, raw, 3);
    const characters = `${FULL.slice(0, 2)}X${FULL.slice(2, 2 * G)}`;
    expect(input).toHaveValue(grouped(characters));
    await waitFor(() => {
      expect(input.selectionStart).toBe(caretAfter(3));
      expect(input.selectionEnd).toBe(caretAfter(3));
    });
  });

  it("B16 a character typed just before a separator moves the caret past the new one", async () => {
    render(<Harness initial={grouped(FULL.slice(0, 2 * G))} />);
    const input = field();
    // "ABCD|-EFGH" + X  ->  raw "ABCDX-EFGH", caret after X: five characters before it.
    const raw = `${FULL.slice(0, G)}X${INVITE_CODE_SEPARATOR}${FULL.slice(G, 2 * G)}`;
    changeAt(input, raw, G + 1);
    expect(input).toHaveValue(grouped(`${FULL.slice(0, G)}X${FULL.slice(G, 2 * G)}`));
    await waitFor(() => {
      expect(input.selectionStart).toBe(caretAfter(G + 1));
    });
  });
});

// ---------------------------------------------------------------------------------------------
// B17 / R191: every row of the shared table
// ---------------------------------------------------------------------------------------------

describe("R191 B17 pasting", () => {
  it.each(FILLED_BY_PASTE.map((row) => [row.name, row] as const))(
    "R191 B17 pasting %s fills the field with its code",
    (_name, row) => {
      const log: Change[] = [];
      render(<Harness log={log} />);
      const input = field();
      const code = codeFilledBy(row);

      const notPrevented = paste(input, row.input);

      expect(notPrevented, "the handler takes the paste over").toBe(false);
      expect(input).toHaveValue(grouped(code));
      if (row.canonical !== null) expect(input).toHaveValue(row.formatted);
      expect(root()).toHaveAttribute("data-complete", "true");
      expect(log.at(-1)).toEqual({ formatted: grouped(code), complete: true });
      expect(hint()).toBeNull();
    },
  );

  it.each(READ_CLEAN.map((row) => [row.name, row] as const))(
    "R191 B17 %s is not taken by the paste handler and reads as its formatted column",
    (_name, row) => {
      render(<Harness />);
      const input = field();
      expect(paste(input, row.input), "the paste goes through to onChange").toBe(true);
      fireEvent.change(input, { target: { value: row.input } });
      expect(input).toHaveValue(row.formatted);
      expect(hint()).toBeNull();
      expect(root()).toHaveAttribute("data-complete", "false");
    },
  );

  it.each(READ_WITH_PROBLEM.map((row) => [row.name, row] as const))(
    "R191 B17 %s is refused: only the good part before the problem stays, and the hint names the problem",
    (_name, row) => {
      render(<Harness />);
      const input = field();
      expect(paste(input, row.input), "the paste goes through to onChange").toBe(true);
      fireEvent.change(input, { target: { value: row.input } });

      // A paste that goes wrong partway keeps what it got right, in view, unless that would
      // already be a whole code (a 17th character), the problem is its length, or the paste holds
      // more letters and digits than a code (a message, whose "good part" is a word of it).
      const keeps =
        row.input.length > 1 &&
        row.problem !== "tooLong" &&
        row.formatted.length < grouped(FULL).length &&
        letterAndDigitCount(row.input) <= INVITE_CODE_LENGTH;
      expect(input, "nothing is dropped, mapped or shifted").toHaveValue(keeps ? row.formatted : "");
      const shown = hint();
      expect(shown).not.toBeNull();
      expect(shown).toHaveAttribute("data-kind", row.problem ?? "");
      expect(shown).toHaveAttribute("role", "status");
      const message = codeProblemMessage(problemOf(row));
      expect(shown?.textContent).toBe(
        keeps || row.input.length <= 1 ? message : `${message} ${pastedText(row.input)}`,
      );
      expect(root()).toHaveAttribute("data-problem", row.problem ?? "");
      expect(root()).toHaveAttribute("data-complete", "false");
      expect(input).toHaveAttribute("aria-invalid", "true");
    },
  );

  it.each([
    ["one excluded character", `${grouped(FULL.slice(0, -1)).toLowerCase()}0`, "excluded"],
    ["one foreign character", `${grouped(FULL.slice(0, -1)).toLowerCase()}#`, "foreign"],
  ] as const)("R191 B17 a paste with %s keeps its 15 good characters in view, caret at the problem", (_name, pasted, kind) => {
    render(<Harness />);
    const input = field();
    expect(paste(input, pasted)).toBe(true);
    fireEvent.change(input, { target: { value: pasted } });

    expect(input).toHaveValue(grouped(FULL.slice(0, -1)));
    expect(input.selectionStart).toBe(grouped(FULL.slice(0, -1)).length);
    expect(hint()).toHaveAttribute("data-kind", kind);
    expect(root()).toHaveAttribute("data-complete", "false");
  });

  it("R191 B17 a paste one character too long keeps the old value and quotes what was pasted", () => {
    render(<Harness />);
    const input = field();
    const pasted = `${grouped(FULL)}${LETTERS.slice(-1)}`;
    expect(paste(input, pasted)).toBe(true);
    fireEvent.change(input, { target: { value: pasted } });

    // Keeping its first 16 would hand the player a code they never had.
    expect(input).toHaveValue("");
    expect(hint()).toHaveAttribute("data-kind", "tooLong");
    expect(hint()?.textContent).toContain(pastedText(pasted));
    expect(hint()?.textContent).toContain(pasted);
  });

  it("R191 B17 a single refused keystroke is still refused as before, with nothing quoted", async () => {
    const user = userEvent.setup();
    render(<Harness initial={grouped(FULL.slice(0, 3))} />);
    const input = field();
    await user.type(input, "0");
    expect(input).toHaveValue(grouped(FULL.slice(0, 3)));
    expect(hint()?.textContent).toBe(codeProblemMessage({ kind: "excluded", character: "0" }));
  });

  it.each([
    ["a refused code", grouped(LETTERS.slice(LETTERS.length - INVITE_CODE_LENGTH))],
    ["a partial code", grouped(FULL.slice(0, G))],
  ] as const)("R191 B17 a code inserted without a paste event after %s replaces it, as a paste does", (_name, initial) => {
    render(<Harness initial={initial} />);
    const input = field();
    // Dropped at the caret, or put in by a phone keyboard's clipboard chip: no paste event.
    fireEvent.change(input, { target: { value: `${initial}${grouped(FULL)}` } });
    expect(input).toHaveValue(grouped(FULL));
    expect(hint()).toBeNull();
    expect(root()).toHaveAttribute("data-complete", "true");
  });

  it("R191 B17 a paste with padding and spaced dashes is never cut short", () => {
    render(<Harness />);
    const input = field();
    const padded = `  ${grouped(FULL).split(INVITE_CODE_SEPARATOR).join(` ${INVITE_CODE_SEPARATOR} `).toLowerCase()}  `;
    expect(padded.length, "premise: longer than the formatted code").toBeGreaterThan(grouped(FULL).length);

    expect(paste(input, padded)).toBe(false);
    expect(input).toHaveValue(grouped(FULL));
  });

  it("R191 B17 the same padded text typed or dropped in (no paste event) still reads whole", () => {
    render(<Harness />);
    const input = field();
    const padded = `\t ${grouped(FULL).toLowerCase().split(INVITE_CODE_SEPARATOR).join("  ")} \n`;
    fireEvent.change(input, { target: { value: padded } });
    expect(input).toHaveValue(grouped(FULL));
    expect(root()).toHaveAttribute("data-complete", "true");
  });

  it("R191 B17 a pasted code replaces a half-typed one", () => {
    render(<Harness initial={grouped(FULL.slice(0, 3))} />);
    const input = field();
    const other = LETTERS.slice(LETTERS.length - INVITE_CODE_LENGTH);
    expect(paste(input, grouped(other))).toBe(false);
    expect(input).toHaveValue(grouped(other));
  });
});

// ---------------------------------------------------------------------------------------------
// B18 / R191: an excluded character is refused and named, never dropped
// ---------------------------------------------------------------------------------------------

describe("R191 B18 excluded characters", () => {
  it.each(EXCLUDED.map((character) => [character] as const))(
    "R191 B18 typing %s leaves the value unchanged and names it and the excluded set",
    async (character) => {
      const user = userEvent.setup();
      render(<Harness initial={grouped(FULL.slice(0, G))} />);
      const input = field();

      await user.type(input, character);

      expect(input).toHaveValue(grouped(FULL.slice(0, G)));
      const shown = hint();
      expect(shown).not.toBeNull();
      expect(shown).toHaveAttribute("data-kind", "excluded");
      expect(shown?.textContent).toBe(codeProblemMessage({ kind: "excluded", character }));
      expect(shown?.textContent).toContain(character);
      for (const excluded of EXCLUDED) expect(shown?.textContent).toContain(excluded);
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(root()).toHaveAttribute("data-problem", "excluded");
    },
  );

  it.each([["o"], ["i"]] as const)(
    "R191 B18 a lowercase %s is excluded too, after upper-casing",
    async (character) => {
      const user = userEvent.setup();
      render(<Harness initial={grouped(FULL.slice(0, 2))} />);
      const input = field();
      await user.type(input, character);
      expect(input).toHaveValue(grouped(FULL.slice(0, 2)));
      expect(hint()).toHaveAttribute("data-kind", "excluded");
      expect(hint()?.textContent).toBe(
        codeProblemMessage({ kind: "excluded", character: character.toUpperCase() }),
      );
    },
  );

  it("R191 B18 the next accepted keystroke clears the hint", async () => {
    const user = userEvent.setup();
    render(<Harness initial={grouped(FULL.slice(0, G))} />);
    const input = field();
    await user.type(input, EXCLUDED[0] ?? "0");
    expect(hint()).not.toBeNull();

    await user.type(input, FULL.charAt(G).toLowerCase());
    expect(input).toHaveValue(grouped(FULL.slice(0, G + 1)));
    expect(hint()).toBeNull();
    expect(root()).not.toHaveAttribute("data-problem");
    expect(input).not.toHaveAttribute("aria-invalid", "true");
  });

  it("R191 B18 a code with an excluded character inside keeps only what came before it, never shifted", () => {
    render(<Harness />);
    const input = field();
    const typo = `${FULL.slice(0, G)}0${FULL.slice(G + 1)}`;
    const shifted = grouped(`${FULL.slice(0, G)}${FULL.slice(G + 1)}`);

    expect(paste(input, grouped(typo)), "no code in it for the handler to take").toBe(true);
    fireEvent.change(input, { target: { value: grouped(typo) } });

    expect(input).toHaveValue(FULL.slice(0, G));
    expect(input).not.toHaveValue(shifted);
    expect(hint()).toHaveAttribute("data-kind", "excluded");
    expect(hint()?.textContent).toBe(codeProblemMessage({ kind: "excluded", character: "0" }));
  });

  it("R191 B18 a foreign character is refused and named as foreign", async () => {
    const user = userEvent.setup();
    render(<Harness initial={grouped(FULL.slice(0, 3))} />);
    const input = field();
    await user.type(input, "#");
    expect(input).toHaveValue(grouped(FULL.slice(0, 3)));
    expect(hint()).toHaveAttribute("data-kind", "foreign");
    expect(hint()?.textContent).toBe(codeProblemMessage({ kind: "foreign", character: "#" }));
  });

  it("R191 B18 a character past a complete code is refused as tooLong", async () => {
    const user = userEvent.setup();
    render(<Harness initial={grouped(FULL)} />);
    const input = field();
    await user.type(input, LETTERS.charAt(LETTERS.length - 1).toLowerCase());
    expect(input).toHaveValue(grouped(FULL));
    expect(hint()).toHaveAttribute("data-kind", "tooLong");
    expect(hint()?.textContent).toBe(codeProblemMessage({ kind: "tooLong" }));
  });
});

// ---------------------------------------------------------------------------------------------
// B19: Backspace never sticks on a separator
// ---------------------------------------------------------------------------------------------

describe("B19 Backspace", () => {
  it("B19 Backspace right after a separator deletes the character before it", async () => {
    const user = userEvent.setup();
    render(<Harness initial={grouped(FULL)} />);
    const input = field();
    input.focus();
    input.setSelectionRange(G + 1, G + 1); // "ABCD-|EFGH-…"

    await user.keyboard("{Backspace}");

    expect(input).toHaveValue(grouped(`${FULL.slice(0, G - 1)}${FULL.slice(G)}`));
    await waitFor(() => {
      expect(input.selectionStart).toBe(caretAfter(G - 1));
    });
  });

  it("B19 each Backspace after a separator removes one character: it never gets stuck", async () => {
    const user = userEvent.setup();
    render(<Harness initial={grouped(FULL)} />);
    const input = field();
    const before = 3 * G; // the caret right after the last separator
    const caret = caretAfter(before) + 1;
    expect(input.value.charAt(caret - 1), "premise: the caret follows a separator").toBe(
      INVITE_CODE_SEPARATOR,
    );
    input.focus();
    input.setSelectionRange(caret, caret);

    for (let remaining = before; remaining > 0; remaining -= 1) {
      const length = input.value.replaceAll(INVITE_CODE_SEPARATOR, "").length;
      await user.keyboard("{Backspace}");
      expect(input.value.replaceAll(INVITE_CODE_SEPARATOR, "").length, "one character per press").toBe(
        length - 1,
      );
    }
    expect(input).toHaveValue(grouped(FULL.slice(before)));
  });

  it("B19 holding Backspace from the end empties a full code", async () => {
    const user = userEvent.setup();
    render(<Harness initial={grouped(FULL)} />);
    const input = field();
    const length = input.value.length;
    input.focus();
    input.setSelectionRange(length, length);

    for (let press = 0; press < length; press += 1) {
      await user.keyboard("{Backspace}");
    }

    expect(input).toHaveValue("");
    expect(progress().textContent).toContain(`0 of ${String(INVITE_CODE_LENGTH)}`);
    for (let index = 0; index < INVITE_CODE_GROUPS; index += 1) {
      expect(segment(index)).toHaveAttribute("data-state", "empty");
    }
  });
});

// ---------------------------------------------------------------------------------------------
// B19: nor do Delete and the arrow keys (the adversarial panel's findings)
// ---------------------------------------------------------------------------------------------

describe("B19 Delete and the arrows at a group boundary", () => {
  it("B19 Delete right before a separator deletes the character after it, and the caret stays", async () => {
    const user = userEvent.setup();
    render(<Harness initial={grouped(FULL.slice(0, 2 * G))} />);
    const input = field();
    input.focus();
    input.setSelectionRange(G, G); // "ABCD|-EFGH": drawn before E, where a click on E puts it

    await user.keyboard("{Delete}");

    expect(input).toHaveValue(grouped(`${FULL.slice(0, G)}${FULL.slice(G + 1, 2 * G)}`));
    await waitFor(() => {
      expect(input.selectionStart).toBe(caretAfter(G));
    });
  });

  it("B19 holding Delete from the start of a group empties the rest of the code", async () => {
    const user = userEvent.setup();
    render(<Harness initial={grouped(FULL.slice(0, 2 * G))} />);
    const input = field();
    input.focus();
    input.setSelectionRange(G, G);

    for (let press = 0; press <= G; press += 1) {
      await user.keyboard("{Delete}");
    }

    expect(input).toHaveValue(FULL.slice(0, G));
  });

  it("B19 an arrow key crosses a separator and the character beyond it, never only the separator", async () => {
    const user = userEvent.setup();
    render(<Harness initial={grouped(FULL.slice(0, 2 * G))} />);
    const input = field();
    input.focus();
    input.setSelectionRange(G, G); // before the separator

    await user.keyboard("{ArrowRight}");
    expect(input.selectionStart, "after the first character of the next group").toBe(caretAfter(G + 1));

    input.setSelectionRange(G + 1, G + 1); // just after the separator
    await user.keyboard("{ArrowLeft}");
    expect(input.selectionStart, "before the last character of the group before").toBe(G - 1);
  });
});

// ---------------------------------------------------------------------------------------------
// B17: text that arrives without a paste event is read like a paste
// ---------------------------------------------------------------------------------------------

describe("R191 B17 text dropped or inserted by a keyboard's clipboard chip", () => {
  it("R191 B17 fills the field from an invite sentence inserted in one change", () => {
    render(<Harness />);
    const input = field();
    const text = "Your invite: abcd-efgh-jkmn-pqrs.";
    const code = findCodeInText(text, INVITE_CODE_FORMAT);
    expect(code, "premise: the sentence holds one code").not.toBeNull();

    changeAt(input, text, text.length);

    expect(input).toHaveValue(grouped(code ?? ""));
    expect(hint()).toBeNull();
    expect(root()).toHaveAttribute("data-complete", "true");
  });

  it("R191 B17 still refuses a one-character keystroke outside the alphabet", () => {
    render(<Harness initial={FULL.slice(0, 2)} />);
    const input = field();
    changeAt(input, `${FULL.slice(0, 2)}${EXCLUDED[0] ?? "0"}`, 3);
    expect(input).toHaveValue(FULL.slice(0, 2));
    expect(hint()).toHaveAttribute("data-kind", "excluded");
  });
});

describe("R191 a keyboard that types through IME composition (Android's Gboard)", () => {
  const WORD = FULL.slice(0, G + 2);

  it("R191 the composing text is left exactly as the keyboard wrote it, while the groups follow it", () => {
    const log: Change[] = [];
    render(<Harness log={log} />);
    const input = field();

    fireEvent.compositionStart(input);
    // Lower case, no separator: rewriting it mid-composition is what doubles or drops characters.
    for (let length = 1; length <= WORD.length; length += 1) {
      changeAt(input, WORD.slice(0, length).toLowerCase(), length);
      expect(input).toHaveValue(WORD.slice(0, length).toLowerCase());
    }
    // The drawn groups, the count and the parent already have the code as it will read.
    expect(segment(0)).toHaveAttribute("data-state", "complete");
    expect(segment(1)).toHaveAttribute("data-state", "partial");
    expect(log.at(-1)).toEqual({ formatted: grouped(WORD), complete: false });

    fireEvent.compositionEnd(input);
    // Once the keyboard is done, the value is formatted like any other.
    expect(input).toHaveValue(grouped(WORD));
    expect(hint()).toBeNull();
  });

  it("R191 an excluded character in a composition is named at once and refused once it ends", () => {
    render(<Harness />);
    const input = field();
    const bad = EXCLUDED[0] ?? "0";

    fireEvent.compositionStart(input);
    changeAt(input, FULL.slice(0, 2).toLowerCase(), 2);
    changeAt(input, `${FULL.slice(0, 2).toLowerCase()}${bad}`, 3);
    // Named, but the keyboard's text is not touched mid-composition.
    expect(hint()).toHaveAttribute("data-kind", "excluded");
    expect(input).toHaveValue(`${FULL.slice(0, 2).toLowerCase()}${bad}`);

    fireEvent.compositionEnd(input);
    // Never dropped or mapped (R191): the good part stays, and the hint still names the character.
    expect(input).toHaveValue(FULL.slice(0, 2));
    expect(hint()).toHaveAttribute("data-kind", "excluded");
  });
});

// ---------------------------------------------------------------------------------------------
// A pasted message, a selection, and a letter from another keyboard
// ---------------------------------------------------------------------------------------------

describe("R191 B17 a whole chat message pasted", () => {
  it.each([
    ["my invite code is abcd efgh jkmn pqrs"],
    ["hey, my code is abcd efgh jkmn pqrs"],
    ["abcd efgh jkmn pqrs thanks"],
    ["MY CODE IS ABCD EFGH JKMN PQRS"],
  ] as const)("R191 B17 %j fills the field with the one code in it", (message) => {
    render(<Harness />);
    const input = field();
    expect(paste(input, message), "the handler takes the paste over").toBe(false);
    expect(input).toHaveValue("ABCD-EFGH-JKMN-PQRS");
    expect(hint()).toBeNull();
  });

  it("R191 B17 a message whose code is mistyped keeps the old value and quotes it, never a word of it", () => {
    render(<Harness initial={grouped(FULL.slice(0, 3))} />);
    const input = field();
    // The code in it holds a 0, so there is no code to find, and its "good part" would be "MYC".
    const message = "my code: abcd-efgh-jkmn-pqr0";
    expect(findCodeInText(message, INVITE_CODE_FORMAT), "premise: nothing is found").toBeNull();
    expect(paste(input, message)).toBe(true);
    changeAt(input, `${grouped(FULL.slice(0, 3))}${message}`, grouped(FULL.slice(0, 3)).length + message.length);

    expect(input).toHaveValue(grouped(FULL.slice(0, 3)));
    expect(hint()?.textContent).toContain(pastedText(message));
  });
});

describe("a selection in the code field", () => {
  it("is drawn on the cells it covers, and the drawn caret is hidden while it stands", () => {
    render(<Harness initial={grouped(FULL)} />);
    const input = field();
    input.focus();
    fireEvent.focus(input);
    input.setSelectionRange(0, input.value.length);
    fireEvent.select(input);

    for (let index = 0; index < INVITE_CODE_GROUPS; index += 1) {
      const cells = segment(index).querySelectorAll("[data-cell]");
      const marked = segment(index).querySelectorAll('[data-cell][data-selected="true"]');
      expect(marked.length, `segment ${String(index)}`).toBe(cells.length);
    }
    expect(document.querySelectorAll("[data-caret]")).toHaveLength(0);

    // Part of the second group: only those cells.
    input.setSelectionRange(G + 1, G + 3);
    fireEvent.select(input);
    const marked = [...document.querySelectorAll('[data-cell][data-selected="true"]')];
    expect(marked.map((cell) => cell.textContent)).toEqual([FULL.charAt(G), FULL.charAt(G + 1)]);

    // Collapsed again: no cell marked, and the caret is drawn.
    input.setSelectionRange(2, 2);
    fireEvent.select(input);
    expect(document.querySelectorAll('[data-cell][data-selected="true"]')).toHaveLength(0);
    expect(document.querySelectorAll("[data-caret]")).toHaveLength(1);
  });
});

describe("the hint for a letter from another keyboard", () => {
  it("never says 'capital letters' to a capital, and says to switch the keyboard to Latin letters", () => {
    render(<Harness initial="ABC" />);
    // The key that is "A" on a Latin layout types "ф" on a Russian one; upper-cased it is "Ф".
    changeAt(field(), "ABCф", 4);
    const shown = hint()?.textContent ?? "";
    expect(shown).toBe(codeProblemMessage({ kind: "foreign", character: "Ф" }));
    expect(shown).not.toMatch(/capital letters/);
    expect(shown).toMatch(/letters A–Z except I and O, and the digits 2–9/);
    expect(shown).toMatch(/keyboard is set to Latin letters/);
  });

  it("a symbol is told what codes use, with nothing about keyboards", () => {
    expect(codeProblemMessage({ kind: "foreign", character: "#" })).toBe(
      "“#” isn’t used in invite codes. They use the letters A–Z except I and O, and the digits 2–9.",
    );
  });
});

describe("R192 a stated wait in words", () => {
  it("R192 reads the hour-long redemption window as an hour, never 'about 60 minutes'", () => {
    expect(waitInWords(CODE_ATTEMPT_WINDOW_SECONDS * 1000)).toBe("about an hour");
    expect(waitInWords(30_000)).toBe("about a minute");
    expect(waitInWords(12 * 60_000)).toBe("about 12 minutes");
    expect(waitInWords(59 * 60_000)).toBe("about 59 minutes");
    expect(waitInWords(2 * 3_600_000)).toBe("about 2 hours");
    expect(`Wait ${waitInWords(CODE_ATTEMPT_WINDOW_SECONDS * 1000)}, then try again.`).not.toMatch(/60 minutes/);
  });
});
