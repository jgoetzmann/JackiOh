// The landing page: `/`, the one screen that is not a form.
//
// NO SPEC RULE LIVES HERE. It is the front door (docs/polish/5-sign-in.md, B37-B39): a warm tavern
// hero with the wordmark and a fanned hand of cards, one dominant call to action, and a short strip
// that says how the game plays, with every number read from the config that owns it (CLAUDE.md
// rule 9). Everything visual is CSS in `landing.css`, scoped under `.landing` (its palette is
// `auth/tavern.css`'s, which the sign-in screens share), so nothing here can move the board's
// pixel-measured layout (index.css's header says why that matters).
//
// The page is not gated, so it asks for the account itself. `useAccount` answers `loading` first,
// and the corner stays empty for that beat rather than flashing "Sign in" at somebody who is. A
// beat, not a minute: a sleeping server can take most of one to wake, so after
// `GATE_SLOW_NOTICE_SECONDS` the corner offers what this device's own storage says (Account when it
// holds a session, else Sign in) without waiting for the server's answer.

import { useEffect, useState, type ReactElement } from "react";

import { GATE_SLOW_NOTICE_SECONDS } from "../../../server/src/config.ts";

import { DECK_SIZE, MAX_MANA, UNIT_ZONES } from "@jackioh/engine/config";
import { LOADOUT_DECKS } from "@jackioh/validator";

import { landingFanCardTestid, landingStepTestid, landingTestid } from "../auth/testids.ts";
import { useAccount, type Account } from "../net/gate.ts";
import { paths } from "../net/navigate.ts";
import { readSession } from "../net/session.ts";
import { useSetting } from "../settings/store.ts";
import { followInApp } from "./nav.tsx";

import "../auth/tavern.css";
import "./landing.css";

const DEV_ONLY = import.meta.env.MODE !== "production";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

type LandingMotion = "full" | "reduced";
type LandingAccountState = "loading" | "anonymous" | "signed-in";

function prefersReducedMotion(): boolean {
  if (typeof window.matchMedia !== "function") return false;
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/**
 * `data-motion` on the root: the media query, or the settings panel's "Reduce motion". The CSS also
 * honours the media query and the setting's `<html>` attribute directly (index.css), so this
 * attribute is what a test can see, not the only thing stopping motion.
 */
function useMotion(): LandingMotion {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  const settingReduces = useSetting("reduceMotion");

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = (): void => {
      setReduced(query.matches);
    };
    onChange();
    if (typeof query.addEventListener !== "function") return undefined;
    query.addEventListener("change", onChange);
    return () => {
      query.removeEventListener("change", onChange);
    };
  }, []);

  return reduced || settingReduces ? "reduced" : "full";
}

function accountState(account: Account): LandingAccountState {
  if (account.kind === "loading") return "loading";
  if (account.kind === "ready") return "signed-in";
  // A read that failed (an unreachable or rate-limiting server) says nothing about the device: one
  // that holds a session is offered its account screen, where sign-out is, not a sign-in that would
  // replace (and revoke) that session and then meet the same unreachable server.
  if (account.kind === "error" && readSession() !== null) return "signed-in";
  return "anonymous";
}

// ---------------------------------------------------------------------------------------------
// The hand of cards
// ---------------------------------------------------------------------------------------------

type FanTone = "ember" | "tide" | "radiant" | "grove" | "back";

type FanCard = {
  readonly tone: FanTone;
  /** The cost gem. A glyph, never a numeral: these cards are decoration and cost nothing. */
  readonly gem: string;
  /** The art window's emblem, or the rune on the back. */
  readonly sigil: string;
};

/** Five cards, left to right. The middle one is radiant and the last is face down. */
const FAN_CARDS: readonly FanCard[] = [
  { tone: "ember", gem: "✦", sigil: "✺" },
  { tone: "tide", gem: "◆", sigil: "☾" },
  { tone: "radiant", gem: "✧", sigil: "♛" },
  { tone: "grove", gem: "❖", sigil: "♞" },
  { tone: "back", gem: "", sigil: "❂" },
];

function FanCardFace({ card }: { card: FanCard }): ReactElement {
  if (card.tone === "back") {
    return (
      <span className="landing-fan-back">
        <span className="landing-fan-rune">{card.sigil}</span>
      </span>
    );
  }
  return (
    <>
      <span className="landing-fan-art">
        <span className="landing-fan-sigil">{card.sigil}</span>
      </span>
      <span className="landing-fan-gem">{card.gem}</span>
      <span className="landing-fan-ribbon">
        <span className="landing-fan-name" />
      </span>
      <span className="landing-fan-text">
        <span className="landing-fan-line landing-fan-line--keyword" />
        <span className="landing-fan-line" />
        <span className="landing-fan-line landing-fan-line--short" />
      </span>
      <span className="landing-fan-stat landing-fan-stat--attack" />
      <span className="landing-fan-stat landing-fan-stat--health" />
    </>
  );
}

function CardFan(): ReactElement {
  return (
    <div className="landing-fan" data-testid={landingTestid.fan} aria-hidden="true">
      {FAN_CARDS.map((card, index) => (
        <div key={card.tone} className="landing-fan-slot">
          <div
            className={`landing-fan-card landing-fan-card--${card.tone}`}
            data-testid={landingFanCardTestid(index)}
            data-face={card.tone === "back" ? "down" : "up"}
            data-radiant={card.tone === "radiant" ? "true" : undefined}
          >
            <FanCardFace card={card} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Drifting sparks over the hearth. The design allows at most twelve. */
const EMBER_COUNT = 10;

function Backdrop(): ReactElement {
  return (
    <div className="landing-backdrop" aria-hidden="true">
      <div className="landing-hearth" />
      <div className="landing-table" />
      <div className="landing-embers">
        {Array.from({ length: EMBER_COUNT }, (_, index) => (
          <span key={index} className="landing-ember" />
        ))}
      </div>
      <div className="landing-vignette" />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The corner slot and the calls to action
// ---------------------------------------------------------------------------------------------

/** True once the account has been loading for `GATE_SLOW_NOTICE_SECONDS`. */
function useSlowLoading(account: Account): boolean {
  const loading = account.kind === "loading";
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!loading) {
      setSlow(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setSlow(true);
    }, GATE_SLOW_NOTICE_SECONDS * 1000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [loading]);
  return loading && slow;
}

function Corner({ account }: { account: Account }): ReactElement | null {
  const slow = useSlowLoading(account);
  if (account.kind === "loading" && !slow) return null;
  // Signed in, or not known yet (slow, or the read failed) on a device that holds a session.
  const holdsSession = (account.kind === "loading" || account.kind === "error") && readSession() !== null;
  if (account.kind === "ready" || holdsSession) {
    return (
      <a
        className="landing-corner-link"
        href={paths.account}
        data-testid={landingTestid.account}
        onClick={followInApp(paths.account)}
      >
        Account
      </a>
    );
  }
  return (
    <a
      className="landing-corner-link"
      href={paths.login}
      data-testid={landingTestid.signIn}
      onClick={followInApp(paths.login)}
    >
      Sign in
    </a>
  );
}

function Actions(): ReactElement {
  return (
    <nav className="landing-ctas" aria-label="Play">
      <a
        className="landing-cta landing-cta--primary"
        href={paths.practice}
        data-testid={landingTestid.playAi}
        onClick={followInApp(paths.practice)}
      >
        Play vs AI
      </a>
      <p className="landing-cta-note">No account needed. Pick a difficulty and play.</p>
      <div className="landing-ctas-secondary">
        <a
          className="landing-cta landing-cta--secondary"
          href={paths.play}
          data-testid={landingTestid.playOnline}
          onClick={followInApp(paths.play)}
        >
          Play online
        </a>
        <a
          className="landing-cta landing-cta--secondary"
          href={paths.decks}
          data-testid={landingTestid.buildDecks}
          onClick={followInApp(paths.decks)}
        >
          Build decks
        </a>
      </div>
      {/* Said where the player decides, not after they have signed up and confirmed an email. */}
      <p className="landing-cta-note" data-testid={landingTestid.inviteOnly}>
        Online play is invite-only for now: you&rsquo;ll need an invite code after signing up. Play
        vs AI needs no account.
      </p>
      {DEV_ONLY ? (
        // Dev-only, and really absent in production: main.tsx serves NotFound for /dev/hotseat
        // when MODE is production, so this link would 404 on a deploy. A full page load on
        // purpose, because the hotseat reads its seed and decks from the query at boot.
        <a
          className="landing-dev-link"
          href={`${paths.hotseat}?seed=42&a=first20&b=first20`}
          data-testid={landingTestid.hotseat}
        >
          Hotseat: both seats on this device
        </a>
      ) : null}
    </nav>
  );
}

// ---------------------------------------------------------------------------------------------
// How it plays
// ---------------------------------------------------------------------------------------------

type StepIcon = "mana" | "lanes" | "deck" | "loadout";

type Step = { readonly icon: StepIcon; readonly title: string; readonly text: string };

/** Each tile states exactly one number, and that number comes from the config that owns it. */
const STEPS: readonly Step[] = [
  {
    icon: "mana",
    title: `Mana up to ${MAX_MANA}`,
    text: "You gain a mana crystal each turn and they refill as your turn starts. Spend them on units, spells and traps.",
  },
  {
    icon: "lanes",
    title: `${UNIT_ZONES} lanes a side`,
    text: "Units hold the lanes on your side of the table. Behind them, the backrow keeps your traps face down until they spring.",
  },
  {
    icon: "deck",
    title: `Decks of ${DECK_SIZE}`,
    text: "Every card in a deck is different. Draw, trade and outlast until the other hero falls.",
  },
  {
    icon: "loadout",
    title: `A loadout of ${LOADOUT_DECKS} decks`,
    text: "No card is shared between your decks. Build them once, then take them to the queue or a private room.",
  },
];

// The step icons: drawn, not typed, on a 24-unit grid, in the tile's gold (`currentColor`). A count
// an icon shows (the lanes, the decks of a loadout) is drawn from the same constant its tile states,
// so the picture can never disagree with the sentence beside it (CLAUDE.md rule 9).

const ICON_GRID = 24;
const ICON_CENTRE = ICON_GRID / 2;

/** Where a lane edge `index` of `count` meets a row of the board: the table seen in perspective. */
function laneEdge(index: number, count: number, near: boolean): number {
  const [left, right] = near ? [2.5, 21.5] : [7, 17];
  return left + ((right - left) * index) / count;
}

function ManaIcon(): ReactElement {
  return (
    <>
      <path className="landing-icon-gem" d="M12 2.5 19.5 9 12 21.5 4.5 9Z" />
      <path className="landing-icon-facet" d="M4.5 9h15M8.5 9 12 2.5 15.5 9M8.5 9 12 21.5 15.5 9" />
    </>
  );
}

/** The table from a seat: one side's lanes running away from the viewer, and the centre line. */
function LanesIcon(): ReactElement {
  const dividers = Array.from({ length: UNIT_ZONES - 1 }, (_, index) => index + 1);
  return (
    <>
      <path className="landing-icon-card" d="M7 4H17L21.5 20H2.5Z" />
      <path className="landing-icon-line" d="M5.2 12H18.8" />
      {dividers.map((index) => (
        <path
          key={index}
          className="landing-icon-facet landing-icon-lane-edge"
          d={`M${String(laneEdge(index, UNIT_ZONES, false))} 4L${String(laneEdge(index, UNIT_ZONES, true))} 20`}
        />
      ))}
    </>
  );
}

function DeckIcon(): ReactElement {
  return (
    <>
      <rect className="landing-icon-slot" x={8.5} y={2.5} width={11} height={15} rx={1.6} />
      <rect className="landing-icon-slot" x={6.75} y={4.25} width={11} height={15} rx={1.6} />
      <rect className="landing-icon-card" x={5} y={6} width={11} height={15} rx={1.6} />
      <path className="landing-icon-facet" d="M10.5 10.5 12.8 13.5 10.5 16.5 8.2 13.5Z" />
    </>
  );
}

/** One card for each deck of a loadout, fanned from the bottom; the middle one in front. */
function LoadoutIcon(): ReactElement {
  const middle = (LOADOUT_DECKS - 1) / 2;
  const order = Array.from({ length: LOADOUT_DECKS }, (_, index) => index).sort(
    (a, b) => Math.abs(b - middle) - Math.abs(a - middle),
  );
  return (
    <>
      {order.map((index) => (
        <g key={index} transform={`rotate(${String((index - middle) * 22)} ${String(ICON_CENTRE)} 21)`}>
          <rect
            className={`landing-icon-deck ${index === Math.round(middle) ? "landing-icon-card" : "landing-icon-back"}`}
            x={7.5}
            y={4}
            width={9}
            height={13}
            rx={1.4}
          />
        </g>
      ))}
    </>
  );
}

const STEP_ICONS: Readonly<Record<StepIcon, () => ReactElement>> = {
  mana: ManaIcon,
  lanes: LanesIcon,
  deck: DeckIcon,
  loadout: LoadoutIcon,
};

function StepIconMark({ icon }: { icon: StepIcon }): ReactElement {
  const Drawing = STEP_ICONS[icon];
  return (
    <svg
      className={`landing-step-icon landing-step-icon--${icon}`}
      viewBox={`0 0 ${String(ICON_GRID)} ${String(ICON_GRID)}`}
      aria-hidden="true"
      focusable="false"
    >
      <Drawing />
    </svg>
  );
}

function HowItPlays(): ReactElement {
  return (
    <section
      className="landing-how"
      data-testid={landingTestid.howItPlays}
      aria-labelledby="landing-how-title"
    >
      <h2 id="landing-how-title" className="landing-how-title">
        How it plays
      </h2>
      <ol className="landing-steps">
        {STEPS.map((step, index) => (
          <li key={step.title} className="landing-step" data-testid={landingStepTestid(index)}>
            <span className="landing-step-glyph" aria-hidden="true">
              <StepIconMark icon={step.icon} />
            </span>
            <h3 className="landing-step-title">{step.title}</h3>
            <p className="landing-step-text">{step.text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------------

export default function LandingRoute(): ReactElement {
  const account = useAccount();
  const motion = useMotion();

  return (
    <div
      className="landing tavern"
      data-testid={landingTestid.root}
      data-motion={motion}
      data-account={accountState(account)}
    >
      <section className="landing-hero" aria-labelledby="landing-title">
        <Backdrop />

        <header className="landing-topbar">
          <div className="landing-corner">
            <Corner account={account} />
          </div>
        </header>

        <div className="landing-hero-inner">
          <div className="landing-title-block">
            <p className="landing-kicker">A duel of lanes, mana and hidden traps</p>
            <h1 id="landing-title" className="landing-wordmark">
              JackiOh
            </h1>
            <p className="landing-lede">
              Summon units into lanes, set traps face down in your backrow, and break the other hero
              before they break yours.
            </p>
          </div>

          <CardFan />

          <Actions />
        </div>
      </section>

      <HowItPlays />
    </div>
  );
}
