// The open deck's sidebar: its head (the name field, passed in), the deck's count and meter, its
// mana curve, a Hearthstone-style list of tiles, and (as children) the comparison, the verdict and
// the actions (docs/polish/6-cards.md, Surface D; SPEC §9.4, R250–R251).
//
// One deck is open at a time in the workshop, so nothing here carries a deck number: the region is
// `deck-drop`, the list `deck-cards`, a tile `deck-card-<id>`, and a click on a tile still takes the
// card out. Tiles are drawn in `deckListOrder` (cost, then name), which is display only: the deck's
// own order is what a save sends.
//
// A CARD A COMPARED DECK ALSO HOLDS (R251) keeps its tile and wears a mark: `data-conflict="true"`,
// `data-conflict-with="<deck name>"` and a small flag. It is never taken out on the player's
// behalf; the comparison says what clashes and the player decides.
//
// ON A PHONE the curve and tiles fold behind a "Show list" toggle in the head (closed at first), so
// a full deck's 560 px of sidebar no longer pushes the whole pool below the fold; the name, the
// count, the meter and the rest stay. deckbuilder.css shows the toggle and applies the fold only in
// the one-column layout, so every tile stays mounted, and visible elsewhere.
//
// A tile says what a click does ("Remove Bigot from Aggro"). Hovering it previews the card, a touch
// long-press opens the inspect sheet, and a right-click, the I key, the context-menu key or
// Shift+F10 open the card's detail view, so a keyboard can inspect a card in the list too.

import { useId, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactElement, type ReactNode, type RefObject } from "react";

import type { CardCost, CardDef } from "@jackioh/shared";
import type { CatalogSnapshot } from "@jackioh/validator";

import { CardArt, faceModel, useInspectTrigger } from "../../cards/index.ts";
import { DECK_SIZE } from "./deckSize.ts";
import { deckListOrder } from "./filters.ts";
import ManaCurve from "./ManaCurve.tsx";
import { DB_SIDEBAR, DECK_CARDS, DECK_COUNT, DECK_DROP, DECK_FOLD, deckCardId } from "./testids.ts";
import type { Holder } from "./workshop.ts";

type DeckSidebarProps = {
  /** The open deck's name as it is saved, for the tiles' labels. */
  deckName: string;
  cards: readonly string[];
  catalog: CatalogSnapshot;
  /** Card id → the compared deck that also holds it (R251): marked, never removed. */
  conflicts: ReadonlyMap<string, Holder>;
  /** The name field and anything else drawn above the deck's count. */
  head: ReactNode;
  /** A card dropped on the deck. */
  onDropCard: (event: DragEvent<HTMLElement>) => void;
  onRemove: (cardId: string) => void;
  /** Opens card `cardId`'s detail view. */
  onInspect: (cardId: string) => void;
  /** The comparison, the verdict and the actions, drawn under the deck. */
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
  deckName: string;
  cardId: string;
  def: CardDef | undefined;
  conflict: Holder | undefined;
  onRemove: (cardId: string) => void;
  onInspect: (cardId: string) => void;
};

/** The keys that open a tile's detail view: I, the context-menu key, and Shift+F10. */
export function isInspectKey(event: { key: string; shiftKey: boolean }): boolean {
  return event.key === "i" || event.key === "I" || event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");
}

function DeckTile({ deckName, cardId, def, conflict, onRemove, onInspect }: DeckTileProps): ReactElement {
  const name = def?.name ?? cardId;
  const face = useMemo(
    () => (def === undefined ? null : faceModel({ defId: cardId, def, radiant: false })),
    [cardId, def],
  );
  // Hover shows the whole card and a touch long-press opens the inspect sheet; a right-click opens
  // the detail view; a click still removes the card, as it always has.
  const inspect = useInspectTrigger(face === null ? null : { key: deckCardId(cardId), face }, {
    onContextMenu: () => {
      onInspect(cardId);
    },
  });

  return (
    <li>
      <button
        type="button"
        className="db-tile"
        data-testid={deckCardId(cardId)}
        data-card={cardId}
        data-rarity={def?.rarity}
        data-conflict={conflict === undefined ? undefined : "true"}
        data-conflict-with={conflict?.name}
        aria-label={
          conflict === undefined
            ? `Remove ${name} from ${deckName}`
            : `Remove ${name} from ${deckName} (also in ${conflict.name})`
        }
        title={conflict === undefined ? undefined : `Also in ${conflict.name}`}
        aria-keyshortcuts="I"
        onClick={() => {
          onRemove(cardId);
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
        {conflict === undefined ? null : <span className="db-tile-flag" aria-hidden="true" />}
        <span className="db-tile-pip" data-rarity={def?.rarity} aria-hidden="true" />
      </button>
      {inspect.overlay}
    </li>
  );
}

export default function DeckSidebar(props: DeckSidebarProps): ReactElement {
  const { deckName, cards, catalog, conflicts, head, onDropCard, onRemove, onInspect, children } = props;
  // Layout, not state of the deck: the phone's fold, closed at first.
  const [listOpen, setListOpen] = useState(false);
  const ordered = useMemo(() => deckListOrder(cards, catalog), [cards, catalog]);
  const full = cards.length >= DECK_SIZE;
  const list = useRef<HTMLUListElement>(null);
  useScrollEdges(list, cards.length);
  const listId = useId();

  return (
    <aside className="db-sidebar" data-testid={DB_SIDEBAR} aria-label={deckName}>
      {head}
      <section
        className="db-deck"
        aria-label={`Cards in ${deckName}`}
        data-testid={DECK_DROP}
        data-list-open={listOpen ? "true" : "false"}
        onDragOver={allowDrop}
        onDrop={onDropCard}
      >
        <header className="db-deck-head">
          <span className="db-deck-title">Cards</span>
          <span
            className="db-deck-size"
            data-testid={DECK_COUNT}
            data-count={String(cards.length)}
            data-deck-size={String(DECK_SIZE)}
            data-full={full ? "true" : "false"}
          >
            {`${String(cards.length)}/${String(DECK_SIZE)}`}
          </span>
          {cards.length === 0 ? null : (
            <button
              type="button"
              className="db-deck-fold"
              data-testid={DECK_FOLD}
              aria-expanded={listOpen}
              aria-controls={listId}
              onClick={() => {
                setListOpen((open) => !open);
              }}
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
        <ManaCurve cardIds={cards} catalog={catalog} />
        <ul ref={list} id={listId} className="db-deck-list" data-testid={DECK_CARDS}>
          {tileKeys(ordered).map(([cardId, key]) => (
            <DeckTile
              key={key}
              deckName={deckName}
              cardId={cardId}
              def={catalog.cards[cardId]}
              conflict={conflicts.get(cardId)}
              onRemove={onRemove}
              onInspect={onInspect}
            />
          ))}
        </ul>
        {cards.length === 0 ? (
          <p className="db-deck-hint">Tap + on a card in the pool, or drag it here, to add it.</p>
        ) : null}
      </section>

      {children}
    </aside>
  );
}
