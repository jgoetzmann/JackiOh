// The deck sidebar: the three deck tabs, one panel per deck with its mana curve and a
// Hearthstone-style list of tiles, and (as children) the save control.
//
// WHAT IS UNCHANGED, and why it matters. The tabs keep `deck-tab-<n>`, `deck-count-<n>`, their
// drop handling and their `data-active`; each panel keeps `deck-drop-<n>` and its drop handling;
// each list keeps `deck-list-<n>`; each entry keeps its row `deck-<n>-card-<id>` and its button
// `deck-card-<n>-<id>`, and a click on that button still takes the card out. `Deckbuilder.test.tsx`,
// `routes/decks.test.tsx` and spec 09 read all of these.
//
// WHAT IS NEW. Only the active deck's panel is visible; the others are `hidden` but stay mounted,
// so a card in any deck is still in the document for a test (or a drop) to find. Spec 09's drag
// clicks the deck's tab before it drops, which makes that panel the visible one. Tiles are drawn in
// `deckListOrder` (cost, then name), which is display only: the draft's own order is what `save`
// sends.
//
// ON A PHONE the open deck's curve and tiles fold behind a "Show list" toggle in its header
// (closed at first), so a full deck's 560 px of sidebar no longer pushes the whole pool below the
// fold; the tabs, the count, the meter and Save stay. deckbuilder.css shows the toggle and applies
// the fold only in the one-column layout, so every tile stays mounted, and visible elsewhere.
//
// A tile says what a click does ("Remove Bigot from Deck 1"). Hovering it previews the card, a
// touch long-press opens the inspect sheet, and a right-click, the I key, the context-menu key or
// Shift+F10 open the card's detail view, so a keyboard can inspect a card in the list too.

import { useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactElement, type ReactNode, type RefObject } from "react";

import type { CardCost, CardDef } from "@jackioh/shared";
import type { CatalogSnapshot } from "@jackioh/validator";

import { CardArt, faceModel, useInspectTrigger } from "../../cards/index.ts";
import { DECK_SIZE } from "./deckSize.ts";
import { deckListOrder } from "./filters.ts";
import type { Draft } from "./loadout.ts";
import ManaCurve from "./ManaCurve.tsx";
import {
  DB_SIDEBAR,
  deckCardId,
  deckCardRowId,
  deckCountId,
  deckDropId,
  deckFoldId,
  deckListId,
  deckTabId,
} from "./testids.ts";

type DeckSidebarProps = {
  /** One tab and one panel per deck the draft actually has, so an L1 draft is visible. */
  deckNumbers: readonly number[];
  activeDeck: number;
  draft: Draft;
  catalog: CatalogSnapshot;
  onSelectDeck: (deck: number) => void;
  /** A drop on deck `deck`'s tab (`select` true: the tab also opens) or on its panel. */
  onDropCard: (deck: number, event: DragEvent<HTMLElement>, select: boolean) => void;
  onRemove: (deck: number, cardId: string) => void;
  /** Opens card `cardId`'s detail view. */
  onInspect: (cardId: string) => void;
  /** The save control, drawn under the open deck. */
  children?: ReactNode;
};

/** The meter's width is a share of a full deck, as a CSS percentage. */
const FULL_PERCENT = 100;

/** Scroll within this many pixels of an end and the list counts as being at that end. */
const EDGE_SLACK_PX = 1;

/**
 * Marks the deck list with `data-more` ("top", "bottom", "both" or "none"): which of its ends has
 * tiles scrolled out of sight past it. deckbuilder.css fades those ends, so a list that scrolls
 * says so, where before its last tile was simply cut off. A hidden panel measures zero and reads
 * "none" until it opens, which the ResizeObserver sees. jsdom has no layout, so it is always "none"
 * there.
 */
function useScrollEdges(ref: RefObject<HTMLElement | null>, count: number): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return undefined;
    const update = (): void => {
      const hidden = element.scrollHeight - element.clientHeight;
      const top = element.scrollTop > EDGE_SLACK_PX;
      const bottom = element.scrollTop < hidden - EDGE_SLACK_PX;
      const more = top && bottom ? "both" : top ? "top" : bottom ? "bottom" : "none";
      if (element.dataset.more !== more) element.dataset.more = more;
    };
    update();
    element.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [ref, count]);
}

/**
 * A key per tile that survives the list changing around it: the id and which copy of it this is
 * (an illegal draft can hold one twice). A key by list position re-mounted every tile after an
 * insertion, so each of them replayed the entrance that only the new tile should play.
 */
function tileKeys(ordered: readonly string[]): [string, string][] {
  const seen = new Map<string, number>();
  return ordered.map((cardId) => {
    const copy = seen.get(cardId) ?? 0;
    seen.set(cardId, copy + 1);
    return [cardId, `${cardId}:${String(copy)}`];
  });
}

/** A drop target has to say so, or the browser never fires `drop`. */
function allowDrop(event: DragEvent<HTMLElement>): void {
  event.preventDefault();
  try {
    event.dataTransfer.dropEffect = "move";
  } catch {
    // Synthesised events carry no DataTransfer; `preventDefault` is the part that matters.
  }
}

/** The tile's gem: the printed price, and an embiggen card's base price, as its full face shows. */
function tileCost(cost: CardCost | undefined): string {
  if (cost === undefined) return "";
  if (typeof cost === "number") return String(cost);
  if (cost === "X") return cost;
  return String(cost.base);
}

type DeckTileProps = {
  deck: number;
  cardId: string;
  def: CardDef | undefined;
  onRemove: (deck: number, cardId: string) => void;
  onInspect: (cardId: string) => void;
};

/** The keys that open a tile's detail view: I, the context-menu key, and Shift+F10. */
export function isInspectKey(event: { key: string; shiftKey: boolean }): boolean {
  return event.key === "i" || event.key === "I" || event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");
}

function DeckTile({ deck, cardId, def, onRemove, onInspect }: DeckTileProps): ReactElement {
  const name = def?.name ?? cardId;
  const face = useMemo(
    () => (def === undefined ? null : faceModel({ defId: cardId, def, radiant: false })),
    [cardId, def],
  );
  // Hover shows the whole card and a touch long-press opens the inspect sheet; a right-click opens
  // the detail view; a click still removes the card, as it always has.
  const inspect = useInspectTrigger(face === null ? null : { key: deckCardId(deck, cardId), face }, {
    onContextMenu: () => {
      onInspect(cardId);
    },
  });

  return (
    <li data-testid={deckCardRowId(deck, cardId)}>
      <button
        type="button"
        className="db-tile"
        data-testid={deckCardId(deck, cardId)}
        data-card={cardId}
        data-rarity={def?.rarity}
        aria-label={`Remove ${name} from Deck ${String(deck)}`}
        aria-keyshortcuts="I"
        onClick={() => {
          onRemove(deck, cardId);
        }}
        onKeyDown={(event) => {
          if (def === undefined || !isInspectKey(event)) return;
          event.preventDefault();
          onInspect(cardId);
        }}
        {...inspect.handlers}
      >
        <span className="db-tile-cost" data-digits={tileCost(def?.cost).length >= 3 ? "3" : undefined}>
          {tileCost(def?.cost)}
        </span>
        <span className="db-tile-name">{name}</span>
        <span className="db-tile-art">
          {def === undefined ? null : (
            <CardArt defId={cardId} radiant={false} tags={def.tags} type={def.type} shape="strip" />
          )}
        </span>
        <span className="db-tile-pip" data-rarity={def?.rarity} aria-hidden="true" />
      </button>
      {inspect.overlay}
    </li>
  );
}

type DeckPanelProps = {
  deck: number;
  active: boolean;
  /** Whether the phone layout shows this deck's curve and tiles (DeckSidebar's fold). */
  listOpen: boolean;
  onToggleList: () => void;
  cards: readonly string[];
  catalog: CatalogSnapshot;
  onDropCard: (deck: number, event: DragEvent<HTMLElement>, select: boolean) => void;
  onRemove: (deck: number, cardId: string) => void;
  onInspect: (cardId: string) => void;
};

function DeckPanel(props: DeckPanelProps): ReactElement {
  const { deck, active, listOpen, onToggleList, cards, catalog, onDropCard, onRemove, onInspect } = props;
  const ordered = useMemo(() => deckListOrder(cards, catalog), [cards, catalog]);
  const full = cards.length === DECK_SIZE;
  const list = useRef<HTMLUListElement>(null);
  useScrollEdges(list, cards.length);
  const listId = `db-deck-list-${String(deck)}`;

  return (
    <section
      className="db-deck"
      role="tabpanel"
      aria-label={`Deck ${String(deck)}`}
      data-testid={deckDropId(deck)}
      data-deck={deck}
      data-active={active ? "true" : "false"}
      data-list-open={listOpen ? "true" : "false"}
      hidden={!active}
      onDragOver={allowDrop}
      onDrop={(event) => {
        onDropCard(deck, event, false);
      }}
    >
      <header className="db-deck-head">
        <span className="db-deck-title">{`Deck ${String(deck)}`}</span>
        <span className="db-deck-size" data-full={full ? "true" : "false"}>
          {`${String(cards.length)}/${String(DECK_SIZE)}`}
        </span>
        {cards.length === 0 ? null : (
          <button
            type="button"
            className="db-deck-fold"
            data-testid={deckFoldId(deck)}
            aria-expanded={listOpen}
            aria-controls={listId}
            onClick={onToggleList}
          >
            {listOpen ? "Hide list" : "Show list"}
          </button>
        )}
        {/* How full the deck is, at a glance. Drawn only: the count beside it is the number. */}
        <span className="db-deck-meter" data-full={full ? "true" : "false"} aria-hidden="true">
          <span
            className="db-deck-meter-fill"
            style={{ width: `${String(Math.min(1, cards.length / DECK_SIZE) * FULL_PERCENT)}%` }}
          />
        </span>
      </header>
      <ManaCurve deck={deck} cardIds={cards} catalog={catalog} />
      <ul ref={list} id={listId} className="db-deck-list" data-testid={deckListId(deck)}>
        {tileKeys(ordered).map(([cardId, key]) => (
          <DeckTile
            key={key}
            deck={deck}
            cardId={cardId}
            def={catalog.cards[cardId]}
            onRemove={onRemove}
            onInspect={onInspect}
          />
        ))}
      </ul>
      {cards.length === 0 ? (
        <p className="db-deck-hint">Tap + on a card in the pool, or drag it here, to add it.</p>
      ) : null}
    </section>
  );
}

export default function DeckSidebar(props: DeckSidebarProps): ReactElement {
  const { deckNumbers, activeDeck, draft, catalog, onSelectDeck, onDropCard, onRemove, onInspect, children } = props;
  // Layout, not state of the loadout: one switch for every deck, closed at first.
  const [listOpen, setListOpen] = useState(false);
  const toggleList = (): void => {
    setListOpen((open) => !open);
  };

  return (
    <aside className="db-sidebar" data-testid={DB_SIDEBAR} aria-label="Your decks">
      <div className="db-tabs" role="tablist" aria-label="Decks">
        {deckNumbers.map((deck) => (
          <button
            key={deck}
            type="button"
            role="tab"
            data-testid={deckTabId(deck)}
            data-deck={deck}
            aria-selected={deck === activeDeck}
            data-active={deck === activeDeck ? "true" : "false"}
            onClick={() => {
              onSelectDeck(deck);
            }}
            onDragOver={allowDrop}
            onDrop={(event) => {
              onDropCard(deck, event, true);
            }}
          >
            {`Deck ${String(deck)}`}
            <span
              className="db-count"
              data-testid={deckCountId(deck)}
              data-count={String(draft[deck - 1]?.length ?? 0)}
              data-deck-size={String(DECK_SIZE)}
            >
              {`${String(draft[deck - 1]?.length ?? 0)}/${String(DECK_SIZE)}`}
            </span>
          </button>
        ))}
      </div>

      {deckNumbers.map((deck) => (
        <DeckPanel
          key={deck}
          deck={deck}
          active={deck === activeDeck}
          listOpen={listOpen}
          onToggleList={toggleList}
          cards={draft[deck - 1] ?? EMPTY_DECK}
          catalog={catalog}
          onDropCard={onDropCard}
          onRemove={onRemove}
          onInspect={onInspect}
        />
      ))}

      {children}
    </aside>
  );
}

/** A stable empty list, so a missing deck does not re-sort on every render. */
const EMPTY_DECK: readonly string[] = [];
