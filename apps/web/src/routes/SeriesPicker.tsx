// The deck-selection phase of a Conquest series: both players pick at once, from their decks that
// have not won yet, and a pick is sealed until both are in (SPEC §9.5, R331–R333, R338).
//
// It is built the way the board's concurrent mulligan is (R265, R266): choose, then confirm; once
// confirmed the choice is final and the panel turns to "Waiting for your opponent…"; the opponent
// is shown only as "Opponent is choosing…" or "Opponent has picked", never what; and one clock runs
// for both. It wears /play's tavern (lobby.css): a numbered panel, the decks as the mode tiles are
// drawn, the gold call to action, and the searching beacon while it waits. It lives on the series screen rather than on the board because no match exists until
// both decks are known (a match is started with its two decks frozen into it), so a pick survives a
// server restart as part of the series row (R263) and the engine never learns there was a choice.
//
// NOTHING HERE IS A RULE (CLAUDE.md rule 7). Which decks may be picked is the view's (`won`), the
// clock is the server's deadline, and a pick the server refuses is shown in its own words by the
// screen around this panel. A deck the view says has won is shown locked and cannot be selected,
// but the server is the one that refuses it.

import { useEffect, useId, useState, type ReactElement } from "react";

import type { SeriesView } from "../net/api.ts";
import "../auth/tavern.css";
import "./lobby.css";

/** Chrome this panel invented; `e2e/support/testids.ts` mirrors the strings. */
export const seriesPickerTestid = {
  /** The panel: `data-state="choosing|waiting"`, and `data-auto="true"` when the pick was made for you. */
  picker: "series-picker",
  /** One of your decks in the picker: `data-won`, `data-selected`; disabled once it has won (R330). */
  choice: (slot: number): string => `series-pick-${String(slot)}`,
  /** Confirms the selected deck: the pick is sealed from then on (R331). */
  lockIn: "series-lock-in",
  /** The pick clock's whole seconds left (`data-seconds`), R333. */
  clock: "series-pick-clock",
  /** "Opponent is choosing…" or "Opponent has picked" (`data-picked`), R331. */
  opponentStatus: "series-opponent-status",
} as const;

export type SeriesPickerProps = {
  view: SeriesView;
  /** Whole seconds left on the pick clock, on this device's clock. */
  secondsLeft: number;
  /** A request is on its way: nothing more is sent until it answers. */
  busy: boolean;
  /** Seals `slot` as this player's pick for the game. */
  onLockIn: (slot: number) => void;
};

/** How a deck stands in the series, from its owner's side. */
export function deckStanding(deck: SeriesView["you"]["decks"][number]): string {
  if (deck.won) return "Won · locked";
  if (deck.games === 0) return "Not played yet";
  return deck.games === 1 ? "Played once, not won" : `Played ${String(deck.games)} times, not won`;
}

function OpponentStatus({ picked }: { picked: boolean }): ReactElement {
  return (
    <p
      className="series-picker__opponent"
      data-testid={seriesPickerTestid.opponentStatus}
      data-picked={picked ? "true" : "false"}
      role="status"
    >
      {picked ? "Opponent has picked" : "Opponent is choosing…"}
    </p>
  );
}

function Clock({ secondsLeft }: { secondsLeft: number }): ReactElement {
  return (
    <p className="series-picker__clock">
      Time left to pick:{" "}
      <span className="series-clock" data-testid={seriesPickerTestid.clock} data-seconds={secondsLeft}>
        {String(secondsLeft)} s
      </span>
    </p>
  );
}

/** A deck's emblem on its tile: one of the Conquest tile's three shields. Decoration only. */
function DeckIcon(): ReactElement {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className="play-mode-tile__icon">
      <path d="M8 6l8-3 8 3v9c0 6-3.6 10-8 12-4.4-2-8-6-8-12z" />
    </svg>
  );
}

export default function SeriesPicker({ view, secondsLeft, busy, onLockIn }: SeriesPickerProps): ReactElement {
  const titleId = useId();
  const decks = [...view.you.decks].sort((a, b) => a.slot - b.slot);
  const open = decks.filter((deck) => !deck.won);
  // With one deck left there is nothing to choose; the server picks it (R332) and the panel waits.
  const [selected, setSelected] = useState<number | null>(null);
  const pick = view.you.pick;

  // A selection the view no longer allows (a deck that won, a phase that moved on) is dropped.
  const openSlots = open.map((deck) => deck.slot).join(",");
  useEffect(() => {
    if (selected !== null && !openSlots.split(",").includes(String(selected))) setSelected(null);
  }, [selected, openSlots]);

  if (pick !== null) {
    const name = decks.find((deck) => deck.slot === pick)?.name ?? `Deck ${String(pick + 1)}`;
    return (
      <section
        className="lobby-card play-panel series-picker"
        data-testid={seriesPickerTestid.picker}
        data-state="waiting"
        data-auto={view.you.autoPick ? "true" : "false"}
        aria-labelledby={titleId}
      >
        <h2 id={titleId} className="play-panel__heading">
          {`Game ${String(view.gameNo)}: your deck is in`}
        </h2>
        <div className="play-search">
          <span className="play-search__beacon" aria-hidden="true">
            <span className="play-search__ring" />
            <span className="play-search__ring play-search__ring--late" />
          </span>
          <span className="play-search__text">Waiting for your opponent…</span>
        </div>
        <p className="series-picker__sealed" role="status">
          {view.you.autoPick
            ? `${name} is your last deck that hasn’t won, so it was picked for you for game ${String(view.gameNo)}.`
            : `You’re playing ${name} in game ${String(view.gameNo)}. Your pick is sealed: your opponent sees only that you’ve picked.`}
        </p>
        <OpponentStatus picked={view.opponent.picked} />
        <Clock secondsLeft={secondsLeft} />
      </section>
    );
  }

  const chosen = decks.find((deck) => deck.slot === selected) ?? null;
  return (
    <section
      className="lobby-card play-panel series-picker"
      data-testid={seriesPickerTestid.picker}
      data-state="choosing"
      data-auto="false"
      aria-labelledby={titleId}
    >
      <h2 id={titleId} className="play-panel__heading">
        <span className="play-step" aria-hidden="true">
          1
        </span>
        {`Game ${String(view.gameNo)}: choose your deck`}
      </h2>
      <p className="lobby-note">
        Pick a deck that hasn’t won yet. Once you lock it in it’s final, and your opponent sees only that you’ve picked —
        neither of you sees the other’s deck until the game starts. If the clock runs out, your first deck that hasn’t won is
        picked for you.
      </p>
      <fieldset className="lobby-modes series-picker__decks">
        <legend className="lobby-modes__legend">Your decks</legend>
        {decks.map((deck) => {
          const isSelected = selected === deck.slot;
          return (
            <label
              key={deck.slot}
              className="lobby-mode play-mode-tile series-picker__deck"
              data-selected={isSelected ? "true" : "false"}
              data-won={deck.won ? "true" : "false"}
            >
              <input
                type="radio"
                name="series-pick"
                value={String(deck.slot)}
                checked={isSelected}
                disabled={deck.won || busy}
                data-testid={seriesPickerTestid.choice(deck.slot)}
                onChange={() => {
                  setSelected(deck.slot);
                }}
              />
              <DeckIcon />
              <span className="lobby-mode__text">
                <span className="lobby-mode__name">{deck.name}</span>
                <span className="lobby-mode__hint">{`${String(deck.cards.length)} cards`}</span>
              </span>
              <span className="play-mode-tile__waiting series-picker__standing" data-won={deck.won ? "true" : "false"}>
                {deckStanding(deck)}
              </span>
            </label>
          );
        })}
      </fieldset>
      <h2 className="play-panel__heading play-panel__heading--sub">
        <span className="play-step" aria-hidden="true">
          2
        </span>
        Lock it in
      </h2>
      <button
        type="button"
        className="button-primary play-cta"
        data-testid={seriesPickerTestid.lockIn}
        disabled={chosen === null || busy}
        onClick={() => {
          if (chosen !== null) onLockIn(chosen.slot);
        }}
      >
        {chosen === null ? "Choose a deck" : `Lock in ${chosen.name}`}
      </button>
      <OpponentStatus picked={view.opponent.picked} />
      <Clock secondsLeft={secondsLeft} />
    </section>
  );
}
