// One code, typed into one field and drawn as groups (SPEC §9.4, R191).
//
// ONE INPUT, NOT FOUR. A single semantic `<input>` keeps paste, autofill, undo, deletion and screen
// readers working; four linked inputs lose all of them. So the real input sits on top of the
// segments with its text made transparent (`color: transparent`, never `opacity: 0`, which Cypress
// would read as hidden), and the four `aria-hidden` segments underneath draw what it holds. This
// is the `input-otp` pattern.
//
// NOTHING IS DROPPED. Every change is read by `readCodeInput`, the function the server reads the
// submitted code with (R191). A keystroke that introduces a problem (an excluded `0`, `1`, `I` or
// `O`, a character that is in no code, or a 17th character) is refused: the value stays exactly
// as it was and `code-field-hint` names the character. The old field dropped such characters and
// kept going, which shifted every later character and sent a different code. An accepted change
// is re-formatted into groups and the caret is put back after the same number of code characters
// it was after, so typing in the middle of a code stays in the middle.
//
// A REFUSED PASTE STAYS IN VIEW. Several characters inserted at once (a paste, a drop, a keyboard's
// clipboard chip) are read for a code first, the inserted text on its own before the whole value,
// so a code dropped into a field that already holds characters replaces them as a paste does.
// Failing that, a paste that goes wrong partway keeps what it got right: the characters before the
// problem stay in the field with the caret at the problem, so the player can see where it was.
// Two exceptions keep the field's old value and quote what was pasted instead. A paste whose good
// part would already be a whole code (a 17th character, or a stray one after 16 good ones):
// keeping it would hand the player a code they never had. And a paste holding more letters and
// digits than a code has, which is a message and not a mistyped code: its "good part" would be the
// first word of a sentence ("MY", "HEY"), with a hint about a character that is in no code.
//
// A SELECTION IS DRAWN. The input's own highlight is as transparent as its text, so the cells a
// selection covers are marked (`data-selected`) and the drawn caret is hidden while one stands:
// the next keystroke or paste replaces what is marked, and the player can see that it will.
//
// A KEYBOARD THAT COMPOSES IS LEFT TO FINISH. Android keyboards (Gboard) type into a text field
// through IME composition, and rewriting a controlled value in the middle of one (upper-casing it,
// or adding a separator) is a known cause of doubled or dropped characters. So while a composition
// runs, the input shows exactly what the keyboard wrote (`draft`), a clean reading of it still goes
// up to the parent (so the groups, the count and Redeem follow along), and a problem is named but
// nothing is refused. The composed text is read, formatted and, if need be, refused only once the
// composition ends, as if it had been typed in one go.
//
// THERE IS NO `maxLength`. A paste of `" abcd - efgh - jkmn - pqrs "` is longer than the formatted
// code, and a `maxLength` would cut it before `onChange` ever saw it. The reading bounds the input
// instead (`maxInputLength`, then `length`).

import {
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type CompositionEvent,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
} from "react";

import {
  findCodeInText,
  formattedCaret,
  isCodeSeparator,
  normalizeCodeText,
  readCodeInput,
  type CodeFormat,
  type CodeInputProblem,
} from "@jackioh/shared";

import {
  INVITE_CODE_FORMAT,
  codeProblemMessage,
  codeProgressText,
  groupCount,
  pastedText,
  placeholderFor,
} from "./codeInput.ts";
import { codeFieldSegmentTestid, codeFieldTestid, inviteTestid } from "./testids.ts";

import "./code-field.css";

export type CodeFieldProps = {
  /** The `<input>` id, for `<label htmlFor>`. */
  id: string;
  /** Formatted, controlled. */
  value: string;
  onChange: (next: { formatted: string; complete: boolean }) => void;
  /** Defaults to `INVITE_CODE_FORMAT`. */
  format?: CodeFormat;
  /** Defaults to `inviteTestid.input` (`invite-code-input`). */
  testId?: string;
  disabled?: boolean;
  /** Extra `aria-describedby` ids. */
  describedBy?: string;
};

/** How many code characters `text` holds: everything that is not a separator, after reading. */
function codeCharacterCount(text: string): number {
  return normalizeCodeText(text).length;
}

/** The alphabet characters of a formatted value, separators removed. */
function charactersOf(formatted: string): string {
  let characters = "";
  for (const character of formatted) {
    if (!isCodeSeparator(character)) characters += character;
  }
  return characters;
}

/** How many code characters sit before `position` in a formatted value. */
function charactersBefore(formatted: string, position: number): number {
  return charactersOf(formatted.slice(0, position)).length;
}

/** ASCII letters and digits in `text`: how much code-like material a paste carries. */
function letterAndDigitCount(text: string): number {
  let count = 0;
  for (const character of text.normalize("NFKC")) {
    if (/^[0-9A-Za-z]$/u.test(character)) count += 1;
  }
  return count;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

type SegmentState = "empty" | "partial" | "complete";

export default function CodeField(props: CodeFieldProps): ReactElement {
  const format = props.format ?? INVITE_CODE_FORMAT;
  const testId = props.testId ?? inviteTestid.input;
  const { id, value, onChange, disabled = false, describedBy } = props;

  const inputRef = useRef<HTMLInputElement>(null);
  const segmentsRef = useRef<HTMLDivElement>(null);
  /** The caret to restore once React has written the value, or null for "leave it alone". */
  const pendingCaret = useRef<number | null>(null);
  const [problem, setProblem] = useState<CodeInputProblem | null>(null);
  /** The text a refused multi-character insertion carried, quoted in the hint. */
  const [refusedText, setRefusedText] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  /** Code characters before the caret (a selection's start), for the active segment and the caret. */
  const [caretCharacters, setCaretCharacters] = useState(0);
  /** Code characters before a selection's end; equal to `caretCharacters` for a collapsed caret. */
  const [selectedTo, setSelectedTo] = useState(0);
  // A change the parent turns into the value it already holds (a typed separator, a refused
  // character) re-renders nothing upstream, so the caret would never be put back. This does.
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  /** What an IME composition has written so far, shown as it is (A KEYBOARD THAT COMPOSES). */
  const [draft, setDraft] = useState<string | null>(null);

  const reading = readCodeInput(value, format);
  const characters = reading.characters;
  const groups = groupCount(format);

  useLayoutEffect(() => {
    const input = inputRef.current;
    const caret = pendingCaret.current;
    if (input === null || caret === null) return;
    pendingCaret.current = null;
    const at = clamp(caret, 0, input.value.length);
    input.setSelectionRange(at, at);
    collapseAt(charactersBefore(input.value, at));
  });

  /** A collapsed caret after `count` code characters. */
  function collapseAt(count: number): void {
    setCaretCharacters(count);
    setSelectedTo(count);
  }

  function placeCaret(position: number): void {
    pendingCaret.current = position;
    rerender();
  }

  function commit(formatted: string, complete: boolean): void {
    if (formatted !== value) onChange({ formatted, complete });
  }

  function handleChange(event: ChangeEvent<HTMLInputElement>): void {
    if (disabled) return;
    const raw = event.target.value;
    if (draft !== null || (event.nativeEvent as { isComposing?: boolean }).isComposing === true) {
      whileComposing(raw);
      return;
    }
    readChange(raw, event.target.selectionStart ?? raw.length);
  }

  /** A composition's text so far: shown as written, followed by the parent while it reads cleanly. */
  function whileComposing(raw: string): void {
    setDraft(raw);
    const next = readCodeInput(raw, format);
    setProblem(next.problem);
    setRefusedText(null);
    if (next.problem === null) commit(next.formatted, next.complete);
  }

  function handleCompositionStart(event: CompositionEvent<HTMLInputElement>): void {
    if (disabled) return;
    setDraft(event.currentTarget.value);
  }

  /** The composition is over: its text is read like any other change, and may now be rewritten. */
  function handleCompositionEnd(event: CompositionEvent<HTMLInputElement>): void {
    if (disabled || draft === null) return;
    const input = event.currentTarget;
    const raw = input.value;
    setDraft(null);
    readChange(raw, input.selectionStart ?? raw.length);
  }

  /** One change to the input's text, read, formatted or refused (see NOTHING IS DROPPED). */
  function readChange(raw: string, rawCaret: number): void {
    const next = readCodeInput(raw, format);
    const inserted = raw.length - value.length;

    if (next.problem !== null && inserted > 1) {
      // Text that arrives without a paste event (dropped, or committed by a phone keyboard's
      // clipboard suggestion) is one multi-character insertion. Read it the way a paste is read
      // before refusing it, so "Your invite: abcd-…" fills the field however it got there: the
      // inserted text on its own first (it replaces what the field held, as a paste does), then
      // the whole value.
      const insertedText = raw.slice(clamp(rawCaret - inserted, 0, raw.length), rawCaret);
      const found = findCodeInText(insertedText, format) ?? findCodeInText(raw, format);
      if (found !== null) {
        const reading = readCodeInput(found, format);
        setProblem(null);
        setRefusedText(null);
        placeCaret(reading.formatted.length);
        commit(reading.formatted, reading.complete);
        return;
      }

      // A paste at the end that goes wrong partway keeps its good part in view, with the caret at
      // the problem, unless that part would already be a whole code or the paste is a message
      // (see A REFUSED PASTE).
      const atEnd = rawCaret === raw.length;
      const keepsPrefix =
        atEnd &&
        next.problem.kind !== "tooLong" &&
        next.characters.length < format.length &&
        letterAndDigitCount(insertedText) <= format.length;
      setProblem(next.problem);
      if (keepsPrefix) {
        setRefusedText(null);
        placeCaret(next.formatted.length);
        commit(next.formatted, false);
        return;
      }
      setRefusedText(insertedText);
      placeCaret(clamp(rawCaret - inserted, 0, value.length));
      return;
    }

    if (next.problem !== null) {
      // Refused: the value stays, and so does the caret, where it was before the edit.
      setProblem(next.problem);
      setRefusedText(null);
      const inserted = Math.max(0, raw.length - value.length);
      placeCaret(clamp(rawCaret - inserted, 0, value.length));
      return;
    }

    setProblem(null);
    setRefusedText(null);
    const before = clamp(codeCharacterCount(raw.slice(0, rawCaret)), 0, next.characters.length);
    placeCaret(formattedCaret(before, format));
    commit(next.formatted, next.complete);
  }

  function handlePaste(event: ClipboardEvent<HTMLInputElement>): void {
    if (disabled) return;
    const found = findCodeInText(event.clipboardData.getData("text/plain"), format);
    // No single code in it: let the paste through, and `onChange` reads (or refuses) it.
    if (found === null) return;
    event.preventDefault();
    const next = readCodeInput(found, format);
    setProblem(null);
    setRefusedText(null);
    placeCaret(next.formatted.length);
    commit(next.formatted, next.complete);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (disabled) return;
    const input = event.currentTarget;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    if (start === null || start !== end) return;
    const previous = start > 0 ? value[start - 1] : undefined;
    const following = value[start];
    const afterSeparator = previous !== undefined && isCodeSeparator(previous);
    const beforeSeparator = following !== undefined && isCodeSeparator(following);

    // Separators are drawn, not typed: deleting one would change nothing, and the next keystroke
    // would land on it again, so every one of these keys steps over it.
    if (event.key === "Backspace" && afterSeparator) {
      // Delete the character before the separator.
      event.preventDefault();
      const before = charactersBefore(value, start);
      if (before === 0) return;
      const all = charactersOf(value);
      const next = readCodeInput(all.slice(0, before - 1) + all.slice(before), format);
      setProblem(null);
      setRefusedText(null);
      placeCaret(formattedCaret(before - 1, format));
      commit(next.formatted, next.complete);
      return;
    }
    if (event.key === "Delete" && beforeSeparator) {
      // Delete the character after the separator; the caret stays where it is drawn.
      event.preventDefault();
      const before = charactersBefore(value, start);
      const all = charactersOf(value);
      if (before >= all.length) return;
      const next = readCodeInput(all.slice(0, before) + all.slice(before + 1), format);
      setProblem(null);
      setRefusedText(null);
      placeCaret(formattedCaret(before, format));
      commit(next.formatted, next.complete);
      return;
    }
    // Either side of a separator is drawn in the same place, so an arrow that only crossed the
    // separator would look like it did nothing. Cross it and the character beyond.
    if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return;
    if (event.key === "ArrowRight" && beforeSeparator) {
      event.preventDefault();
      moveCaret(Math.min(start + 2, value.length));
    } else if (event.key === "ArrowLeft" && afterSeparator) {
      event.preventDefault();
      moveCaret(Math.max(start - 2, 0));
    }
  }

  function moveCaret(position: number): void {
    const input = inputRef.current;
    if (input === null) return;
    input.setSelectionRange(position, position);
    collapseAt(charactersBefore(value, position));
  }

  function syncCaret(): void {
    const input = inputRef.current;
    if (input === null) return;
    const start = input.selectionStart ?? input.value.length;
    const end = Math.max(start, input.selectionEnd ?? start);
    setCaretCharacters(charactersBefore(input.value, start));
    setSelectedTo(charactersBefore(input.value, end));
  }

  // The input's own text is laid out in its own font, not over the segments, so a click lands the
  // native caret somewhere unrelated to the cell that was clicked. Map the click to the cell.
  function handleMouseUp(event: MouseEvent<HTMLInputElement>): void {
    const root = segmentsRef.current;
    const input = inputRef.current;
    if (root === null || input === null) return;
    if (input.selectionStart !== input.selectionEnd) return; // a drag-selection is left alone
    const cells = Array.from(root.querySelectorAll<HTMLElement>("[data-cell]"));
    let nearest = -1;
    let distance = Number.POSITIVE_INFINITY;
    cells.forEach((cell, index) => {
      const rect = cell.getBoundingClientRect();
      if (rect.width <= 0) return; // no layout (jsdom): keep the native caret
      const gap = Math.abs(event.clientX - (rect.left + rect.width / 2));
      if (gap < distance) {
        distance = gap;
        nearest = index;
      }
    });
    if (nearest < 0) return;
    const at = formattedCaret(Math.min(nearest, characters.length), format);
    input.setSelectionRange(at, at);
    collapseAt(charactersBefore(value, at));
  }

  const activeSegment = focused
    ? Math.min(Math.floor(caretCharacters / format.groupSize), groups - 1)
    : -1;
  /** A selection covers code characters [caretCharacters, selectedTo) while the field has focus. */
  const selecting = focused && selectedTo > caretCharacters;

  const progressId = `${id}-progress`;
  const hintId = `${id}-hint`;
  const describedByIds = [progressId, problem === null ? null : hintId, describedBy ?? null]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(" ");

  const segments: ReactElement[] = [];
  for (let index = 0; index < groups; index += 1) {
    const offset = index * format.groupSize;
    const size = Math.min(format.groupSize, format.length - offset);
    const filled = characters.slice(offset, offset + size);
    const state: SegmentState =
      filled.length === 0 ? "empty" : filled.length === size ? "complete" : "partial";
    const active = index === activeSegment;
    const caretInSegment = caretCharacters - offset;

    const cells: ReactElement[] = [];
    for (let slot = 0; slot < size; slot += 1) {
      const character = filled[slot];
      const at = offset + slot;
      const selected = selecting && character !== undefined && at >= caretCharacters && at < selectedTo;
      let caret: "before" | "after" | undefined;
      if (!selecting && active && caretInSegment === slot) caret = "before";
      else if (!selecting && active && slot === size - 1 && caretInSegment >= size) caret = "after";
      cells.push(
        <span
          key={slot}
          className="code-field__cell"
          data-cell=""
          data-filled={character === undefined ? "false" : "true"}
          {...(selected ? { "data-selected": "true" } : {})}
          {...(caret === undefined ? {} : { "data-caret": caret })}
        >
          {character ?? ""}
        </span>,
      );
    }

    segments.push(
      <span
        key={index}
        className="code-field__segment"
        data-testid={codeFieldSegmentTestid(index)}
        aria-hidden="true"
        data-state={state}
        data-active={active ? "true" : "false"}
      >
        {cells}
      </span>,
    );
  }

  return (
    <div
      className="code-field"
      data-testid={codeFieldTestid.root}
      data-complete={reading.complete ? "true" : "false"}
      {...(problem === null ? {} : { "data-problem": problem.kind })}
      data-disabled={disabled ? "true" : "false"}
      style={{ "--code-field-groups": String(groups) } as CSSProperties}
    >
      <div className="code-field__box">
        <div className="code-field__segments" ref={segmentsRef}>
          {segments}
        </div>
        <input
          ref={inputRef}
          id={id}
          className="code-field__input"
          data-testid={testId}
          name="code"
          type="text"
          inputMode="text"
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          placeholder={placeholderFor(format)}
          value={draft ?? value}
          disabled={disabled}
          aria-invalid={problem === null ? "false" : "true"}
          aria-describedby={describedByIds}
          onChange={handleChange}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onPaste={handlePaste}
          onKeyDown={handleKeyDown}
          onKeyUp={syncCaret}
          onSelect={syncCaret}
          onMouseUp={handleMouseUp}
          onFocus={() => {
            setFocused(true);
            syncCaret();
          }}
          onBlur={() => {
            setFocused(false);
          }}
        />
      </div>

      <p className="code-field__progress" id={progressId} data-testid={codeFieldTestid.progress} aria-live="polite">
        {codeProgressText(reading, format)}
      </p>

      {problem === null ? null : (
        <p
          className="code-field__hint"
          id={hintId}
          data-testid={codeFieldTestid.hint}
          role="status"
          data-kind={problem.kind}
        >
          {codeProblemMessage(problem, format)}
          {refusedText === null ? null : ` ${pastedText(refusedText, format)}`}
        </p>
      )}
    </div>
  );
}
