// The keyword glossary beside an inspected card (B26): one item per term the card uses, in the
// order glossaryFor gives them, each with its label and SPEC's rule text. Nothing when empty.

import type { ReactElement } from "react";
import type { GlossaryEntry } from "../glossary.ts";
import { INSPECT_GLOSSARY } from "./testids.ts";

/** Entries of every list in order, each term once. */
export function mergeGlossary(...lists: readonly (readonly GlossaryEntry[])[]): GlossaryEntry[] {
  const seen = new Set<string>();
  const merged: GlossaryEntry[] = [];
  for (const list of lists) {
    for (const entry of list) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      merged.push(entry);
    }
  }
  return merged;
}

export function Glossary({ entries }: { entries: readonly GlossaryEntry[] }): ReactElement | null {
  if (entries.length === 0) return null;
  return (
    <ul className="inspect-glossary" data-testid={INSPECT_GLOSSARY}>
      {entries.map((entry) => (
        <li key={entry.id} className="inspect-glossary-entry" data-glossary-term={entry.id}>
          <strong className="inspect-glossary-label">{entry.label}</strong>{" "}
          <span className="inspect-glossary-rule">{entry.rule}</span>
        </li>
      ))}
    </ul>
  );
}
