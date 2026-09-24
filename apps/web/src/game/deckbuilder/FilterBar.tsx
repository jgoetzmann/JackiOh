// The deck builder's filter bar: text search, toggle chips for cost, type, tag and rarity, the
// "owned only" checkbox, the sort key and direction, a clear control and the result count.
//
// Controlled and dumb: the filter and the sort live in `Deckbuilder`, and what they mean lives in
// filters.ts. Chips are real toggle buttons (`aria-pressed`), so a keyboard and a screen reader
// get the same control a pointer does.
//
// The cost chips are always on show, as Hearthstone's mana crystals are. The type, tag and rarity
// rows fold behind a "Filters" toggle wherever they would crowd the pool: a phone, and any screen
// under about 860 px tall, where they left a 1280x720 desktop one row of cards (deckbuilder.css
// shows the toggle and hides the folded rows only there). The fold is the one piece of state this
// component owns: it is layout, not a filter, and the chips stay mounted either way.

import { useId, useState, type ReactElement } from "react";

import type { CardType, Rarity, Tag } from "@jackioh/shared";

import {
  COST_BUCKETS,
  DEFAULT_FILTER,
  FILTER_RARITIES,
  FILTER_TAGS,
  FILTER_TYPES,
  SORT_KEYS,
  toggled,
  type CostBucket,
  type PoolFilter,
  type PoolSort,
  type SortKey,
} from "./filters.ts";
import {
  DB_FILTERS,
  DB_FILTER_CLEAR,
  DB_FILTER_TOGGLE,
  DB_FILTER_OWNED,
  DB_RESULT_COUNT,
  DB_SEARCH,
  DB_SORT,
  DB_SORT_DIR,
  filterCostId,
  filterRarityId,
  filterTagId,
  filterTypeId,
} from "./testids.ts";

type FilterBarProps = {
  filter: PoolFilter;
  onFilter: (next: PoolFilter) => void;
  sort: PoolSort;
  onSort: (next: PoolSort) => void;
  /** How many pool cards the current filter shows. */
  count: number;
  /** True when the collection could not be read: ownership is unknown, so the toggle is inert. */
  ownedUnavailable: boolean;
};

const SORT_LABELS: Readonly<Record<SortKey, string>> = {
  cost: "Cost",
  name: "Name",
  rarity: "Rarity",
  attack: "Attack",
  health: "Health",
  type: "Type",
};

type ChipProps = {
  testId: string;
  pressed: boolean;
  label: string;
  title?: string;
  className: string;
  onToggle: () => void;
  /** Rarity chips carry their rarity, so the CSS can reuse the `--rarity-*` tokens. */
  rarity?: Rarity;
};

function Chip({ testId, pressed, label, title, className, onToggle, rarity }: ChipProps): ReactElement {
  return (
    <button
      type="button"
      className={`db-chip ${className}`}
      data-testid={testId}
      aria-pressed={pressed}
      title={title}
      onClick={onToggle}
      data-rarity={rarity}
    >
      {label}
    </button>
  );
}

export default function FilterBar(props: FilterBarProps): ReactElement {
  const { filter, onFilter, sort, onSort, count, ownedUnavailable } = props;

  const setCosts = (bucket: CostBucket) => {
    onFilter({ ...filter, costs: toggled(filter.costs, bucket) });
  };
  const setTypes = (type: CardType) => {
    onFilter({ ...filter, types: toggled(filter.types, type) });
  };
  const setTags = (tag: Tag) => {
    onFilter({ ...filter, tags: toggled(filter.tags, tag) });
  };
  const setRarities = (rarity: Rarity) => {
    onFilter({ ...filter, rarities: toggled(filter.rarities, rarity) });
  };

  const nextDir = sort.dir === "asc" ? "desc" : "asc";
  const [expanded, setExpanded] = useState(false);
  const chipsId = useId();
  // The toggle counts what it hides: the cost chips are never folded away.
  const active = filter.types.size + filter.tags.size + filter.rarities.size;

  return (
    <div
      className="db-filters"
      data-testid={DB_FILTERS}
      data-expanded={expanded ? "true" : "false"}
      role="search"
      aria-label="Filter the card pool"
    >
      <div className="db-filter-row db-filter-row--top">
        <input
          type="search"
          className="db-search"
          data-testid={DB_SEARCH}
          placeholder="Search name, text, keyword, tag…"
          aria-label="Search cards"
          value={filter.search}
          onChange={(event) => {
            onFilter({ ...filter, search: event.target.value });
          }}
        />
        <label className="db-owned">
          <input
            type="checkbox"
            data-testid={DB_FILTER_OWNED}
            checked={filter.ownedOnly}
            disabled={ownedUnavailable}
            onChange={(event) => {
              onFilter({ ...filter, ownedOnly: event.target.checked });
            }}
          />
          <span>Owned only</span>
        </label>
        {/* The sort and its direction wrap as one, so the arrow never ends up alone on a row. */}
        <span className="db-sort-group">
          <label className="db-sort">
            <span className="db-group-label">Sort</span>
            <select
              className="db-sort-select"
              data-testid={DB_SORT}
              value={sort.key}
              onChange={(event) => {
                const key = SORT_KEYS.find((candidate) => candidate === event.target.value);
                if (key !== undefined) onSort({ ...sort, key });
              }}
            >
              {SORT_KEYS.map((key) => (
                <option key={key} value={key}>
                  {SORT_LABELS[key]}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="db-sort-dir"
            data-testid={DB_SORT_DIR}
            data-dir={sort.dir}
            aria-label={sort.dir === "asc" ? "Ascending; switch to descending" : "Descending; switch to ascending"}
            title={sort.dir === "asc" ? "Ascending" : "Descending"}
            onClick={() => {
              onSort({ ...sort, dir: nextDir });
            }}
          >
            <span aria-hidden="true">{sort.dir === "asc" ? "↑" : "↓"}</span>
          </button>
        </span>
        <button
          type="button"
          className="db-filter-toggle"
          data-testid={DB_FILTER_TOGGLE}
          data-active={active > 0 ? "true" : "false"}
          aria-expanded={expanded}
          aria-controls={chipsId}
          onClick={() => {
            setExpanded(!expanded);
          }}
        >
          {active > 0 ? `Filters · ${String(active)}` : "Filters"}
        </button>
        {/* The count and Clear close the top row rather than taking a row of their own, so a
            1280x720 screen shows a full row of cards under the filters. */}
        <span className="db-status">
          <span
            className="db-result-count"
            data-testid={DB_RESULT_COUNT}
            data-count={String(count)}
            role="status"
            aria-live="polite"
          >
            {`${String(count)} ${count === 1 ? "card" : "cards"}`}
          </span>
          <button
            type="button"
            className="db-filter-clear"
            data-testid={DB_FILTER_CLEAR}
            onClick={() => {
              onFilter(DEFAULT_FILTER);
            }}
          >
            Clear filters
          </button>
        </span>
      </div>

      <div className="db-filter-row db-filter-row--cost">
        <div className="db-chip-group" role="group" aria-label="Cost">
          <span className="db-group-label" aria-hidden="true">
            Cost
          </span>
          {COST_BUCKETS.map((bucket) => (
            <Chip
              key={bucket}
              testId={filterCostId(bucket)}
              className="db-chip--cost"
              pressed={filter.costs.has(bucket)}
              label={bucket}
              title={`Cost ${bucket}`}
              onToggle={() => {
                setCosts(bucket);
              }}
            />
          ))}
        </div>
      </div>

      <div className="db-filter-chips" id={chipsId}>
        <div className="db-filter-row">
          <div className="db-chip-group" role="group" aria-label="Type">
            <span className="db-group-label" aria-hidden="true">
              Type
            </span>
            {FILTER_TYPES.map((type) => (
              <Chip
                key={type}
                testId={filterTypeId(type)}
                className="db-chip--type"
                pressed={filter.types.has(type)}
                label={type}
                onToggle={() => {
                  setTypes(type);
                }}
              />
            ))}
          </div>
        </div>

        <div className="db-filter-row">
          <div className="db-chip-group" role="group" aria-label="Tag">
            <span className="db-group-label" aria-hidden="true">
              Tag
            </span>
            {FILTER_TAGS.map((tag) => (
              <Chip
                key={tag}
                testId={filterTagId(tag)}
                className="db-chip--tag"
                pressed={filter.tags.has(tag)}
                label={tag}
                onToggle={() => {
                  setTags(tag);
                }}
              />
            ))}
          </div>
          <div className="db-chip-group" role="group" aria-label="Rarity">
            <span className="db-group-label" aria-hidden="true">
              Rarity
            </span>
            {FILTER_RARITIES.map((rarity) => (
              <Chip
                key={rarity}
                testId={filterRarityId(rarity)}
                className="db-chip--rarity"
                pressed={filter.rarities.has(rarity)}
                label={rarity}
                onToggle={() => {
                  setRarities(rarity);
                }}
                rarity={rarity}
              />
            ))}
          </div>
        </div>
      </div>

    </div>
  );
}
