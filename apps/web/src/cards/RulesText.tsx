// Rules text as a face prints it (docs/polish/6-cards.md, B10; SPEC §10.10). Four things ride on the
// plain words, and this is the one component that draws them, so every surface that prints a
// card's text — a face, the detail view's reading-size lines, the printed text beside a face in
// play — prints them the same way:
//
// - glossary terms ("Cry:", keywords, verbs) in bold (`.cf-term`, rules.ts's tokenizer);
// - on a Radiant face, the stretches its base face's text does not have (`marks`, radiantDiff.ts,
//   R277): gold, bold and underlined (`.cf-mark`), so the mark does not rest on colour alone;
// - the names the card's `refs` link (refs.ts, R279): a reference (`CardRef`), marked everywhere
//   and a control where the surface allows one (refContext.tsx); a term inside a name is not bolded,
//   since the name is the card, not the keyword ("Rush Token");
// - in play, what the card's formula comes to now (`values`, R280), in braces after its label,
//   "{7}" (`.cf-value`): the nth entry with a label after the label's nth occurrence (a fused card
//   prints its ingredients' texts one after the other, R102, and each one's value follows its own
//   line), and one the text does not print that often at the end.
//
// A mark and a reference nest: a mark that holds a whole name holds its reference ("Also add a
// Lava Golem …"), a mark inside a name sits inside the reference ("Rush Tokens"' marked "Tokens"),
// and a mark that crosses a name's edge is cut there, so the elements always nest.
//
// It renders text nodes and spans (and, for an interactive reference, a portal), so it can sit
// inside a <span> inside a <button> — where references stay marks and never become controls.

import { Fragment, type ReactElement, type ReactNode } from "react";

import type { CardDef, PreviewValue } from "@jackioh/shared";

import { CardRef } from "./CardRef.tsx";
import type { TextRange } from "./radiantDiff.ts";
import { useDefResolver } from "./refContext.tsx";
import { findRefs, type RefMatch } from "./refs.ts";
import { tokenizeRules } from "./rules.ts";

type RulesTextProps = {
  text: string;
  /** R277: stretches of `text` the base face does not have. */
  marks?: readonly TextRange[];
  /** R279: the ids `CardDef.refs` lists. */
  refs?: readonly string[];
  /** R280: what the card's formula comes to now, in play. */
  values?: readonly PreviewValue[];
};

type Insert = { at: number; text: string; label: string };
type Term = { start: number; end: number; term: string };
/** A stretch the text is wrapped in: a Radiant mark or a reference. */
type Wrap = { start: number; end: number } & ({ kind: "mark" } | { kind: "ref"; match: RefMatch; def: CardDef });

const NONE: readonly never[] = [];
/** R280: each value after its label's nth occurrence for the nth entry with that label, else at the end. */
function insertsOf(text: string, values: readonly PreviewValue[]): Insert[] {
  const seen = new Map<string, number>();
  return values.map((entry) => {
    const nth = seen.get(entry.label) ?? 0;
    seen.set(entry.label, nth + 1);
    let found = -1;
    if (entry.label !== "") {
      for (let at = 0; at <= nth; at += 1) {
        found = text.indexOf(entry.label, found + 1);
        if (found < 0) break;
      }
    }
    return { at: found < 0 ? text.length : found + entry.label.length, text: String(entry.value), label: entry.label };
  });
}

/** Where each glossary term stands in `text`. */
function termsOf(text: string): Term[] {
  const ranges: Term[] = [];
  let at = 0;
  for (const token of tokenizeRules(text)) {
    if (token.kind === "term") ranges.push({ start: at, end: at + token.text.length, term: token.term });
    at += token.text.length;
  }
  return ranges;
}

/**
 * The marks, each cut at the edge of a reference that it crosses — one it neither holds whole nor
 * lies inside — so that marks and references always nest.
 */
function nestedMarks(marks: readonly TextRange[], refs: readonly TextRange[]): TextRange[] {
  const out: TextRange[] = [];
  for (const mark of marks) {
    const crossed = refs.filter((ref) => ref.start < mark.end && mark.start < ref.end && !contains(mark, ref) && !contains(ref, mark));
    const cuts = crossed
      .flatMap((ref) => [ref.start, ref.end])
      .filter((point) => point > mark.start && point < mark.end)
      .sort((a, b) => a - b);
    let from = mark.start;
    for (const point of new Set(cuts)) {
      out.push({ start: from, end: point });
      from = point;
    }
    out.push({ start: from, end: mark.end });
  }
  return out.filter((range) => range.end > range.start);
}

function contains(outer: { start: number; end: number }, inner: { start: number; end: number }): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

export function RulesText({ text, marks = NONE, refs = NONE, values = NONE }: RulesTextProps): ReactElement {
  const resolve = useDefResolver();
  const defs: CardDef[] = resolve === null ? [] : refs.flatMap((id) => resolve(id) ?? []);
  const matches = defs.length === 0 ? [] : findRefs(text, defs);
  const refWraps: Wrap[] = matches.flatMap((match) => {
    const def = defs.find((candidate) => candidate.id === match.id);
    return def === undefined ? [] : [{ start: match.start, end: match.end, kind: "ref" as const, match, def }];
  });
  const wraps: Wrap[] = [
    ...refWraps,
    ...nestedMarks(marks, refWraps).map((range): Wrap => ({ start: range.start, end: range.end, kind: "mark" })),
  ];
  const terms = termsOf(text);
  const inserts = insertsOf(text, values);
  const emitted = new Set<Insert>();
  let key = 0;
  const next = (): number => (key += 1);

  /** The values owed at `point`, once each. */
  const valuesAt = (point: number): ReactNode[] =>
    inserts
      .filter((insert) => insert.at === point && !emitted.has(insert))
      .map((insert) => {
        emitted.add(insert);
        return (
          <Fragment key={next()}>
            {" "}
            <span className="cf-value" data-value={insert.text} data-label={insert.label} title={`${insert.label}: currently ${insert.text}`}>
              {`{${insert.text}}`}
            </span>
          </Fragment>
        );
      });

  /** Plain words from `start` to `end`: terms in bold unless inside a reference, values where owed. */
  const plain = (start: number, end: number, inRef: boolean): ReactNode[] => {
    const cuts = new Set<number>([start, end]);
    if (!inRef) for (const term of terms) for (const point of [term.start, term.end]) if (point > start && point < end) cuts.add(point);
    for (const insert of inserts) if (insert.at > start && insert.at < end) cuts.add(insert.at);
    const points = [...cuts].sort((a, b) => a - b);
    const out: ReactNode[] = [];
    for (let at = 0; at + 1 < points.length; at += 1) {
      const from = points[at] ?? start;
      const to = points[at + 1] ?? from;
      const words = text.slice(from, to);
      const term = inRef ? undefined : terms.find((range) => range.start <= from && from < range.end);
      out.push(
        term === undefined ? (
          <Fragment key={next()}>{words}</Fragment>
        ) : (
          <strong key={next()} className="cf-term" data-term={term.term}>
            {words}
          </strong>
        ),
      );
      if (to < end) out.push(...valuesAt(to));
    }
    return out;
  };

  /** `start` to `end`, with the wraps inside it drawn around their own contents. */
  const draw = (start: number, end: number, within: readonly Wrap[], inRef: boolean): ReactNode[] => {
    const inside = within.filter((wrap) => wrap.start >= start && wrap.end <= end);
    // The outermost wraps here: those no other wrap holds. A mark and a reference over the very
    // same words put the reference outside.
    const holds = (outer: Wrap, inner: Wrap): boolean =>
      outer !== inner && contains(outer, inner) && (!contains(inner, outer) || outer.kind === "ref");
    const top = inside.filter((wrap) => !inside.some((other) => holds(other, wrap))).sort((a, b) => a.start - b.start);
    const out: ReactNode[] = [];
    let at = start;
    for (const wrap of top) {
      if (wrap.start > at) {
        out.push(...plain(at, wrap.start, inRef));
        out.push(...valuesAt(wrap.start));
      }
      const rest = inside.filter((other) => other !== wrap);
      if (wrap.kind === "mark") {
        out.push(
          <span key={next()} className="cf-mark" data-mark="radiant">
            {draw(wrap.start, wrap.end, rest, inRef)}
          </span>,
        );
      } else {
        out.push(
          <CardRef key={next()} def={wrap.def} radiant={wrap.match.radiant}>
            {draw(wrap.start, wrap.end, rest, true)}
          </CardRef>,
        );
      }
      out.push(...valuesAt(wrap.end));
      at = wrap.end;
    }
    if (at < end) out.push(...plain(at, end, inRef));
    return out;
  };

  return <>{[...draw(0, text.length, wraps, false), ...valuesAt(text.length)]}</>;
}
