// Where a reference finds the card it names, and whether it may be opened (SPEC §10.10, R279).
//
// A reference names a card by id (`CardDef.refs`), and the face it shows is that card's printed
// face from the public catalog (§5.1). A screen that holds the catalog says so with
// `CardDefsProvider` (the deck builder holds a `CatalogSnapshot`); inside a game the board's
// `CatalogContext` already holds it, and a reference reads that when no provider is closer. With
// neither, a name is printed as plain text: nothing is guessed (CLAUDE.md rule 7).
//
// Whether a reference is a control is the surface's call, not the text's. A face inside a button
// (the deck builder's grid), a hover preview (aria-hidden, no pointer events) or a small board
// face marks the name and nothing more; the collection's detail view and the touch inspect sheet
// wrap what they draw in `RefsInteractive`, where a reference is focusable and opens a tooltip.

import { createContext, useContext, useMemo, type ReactElement, type ReactNode } from "react";

import type { CardDef, CardDefs } from "@jackioh/shared";

import { CatalogContext } from "../game/catalog.ts";

/** The printed definition of a catalog card, by id, or undefined when this screen has none. */
export type DefResolver = (id: string) => CardDef | undefined;

const DefsContext = createContext<DefResolver | null>(null);
const InteractiveContext = createContext(false);

/** Makes a catalog's definitions the ones the references below it show. */
export function CardDefsProvider({ defs, children }: { defs: CardDefs; children: ReactNode }): ReactElement {
  const resolve = useMemo<DefResolver>(() => (id) => defs[id], [defs]);
  return <DefsContext.Provider value={resolve}>{children}</DefsContext.Provider>;
}

/** The references below it are controls: focusable, and each opens the card it names (R279). */
export function RefsInteractive({ enabled = true, children }: { enabled?: boolean; children: ReactNode }): ReactElement {
  return <InteractiveContext.Provider value={enabled}>{children}</InteractiveContext.Provider>;
}

/** The closest catalog: a `CardDefsProvider`'s, else the board's `CatalogContext`, else none. */
export function useDefResolver(): DefResolver | null {
  const direct = useContext(DefsContext);
  const lookup = useContext(CatalogContext);
  return useMemo<DefResolver | null>(() => {
    if (direct !== null) return direct;
    if (lookup === null) return null;
    return (id) => lookup(id, false)?.def;
  }, [direct, lookup]);
}

/** Whether a reference drawn here may be focused and opened. */
export function useRefsInteractive(): boolean {
  return useContext(InteractiveContext);
}
