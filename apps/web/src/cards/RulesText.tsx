// Rules text with its glossary terms in bold: "Cry:", "Death:", keywords and verbs
// (docs/polish/6-cards.md, B10). Renders text nodes and <strong class="cf-term"> only, so it can
// sit inside a <span> inside a <button>.

import { Fragment, type ReactElement } from "react";

import { tokenizeRules } from "./rules.ts";

type RulesTextProps = { text: string };

export function RulesText({ text }: RulesTextProps): ReactElement {
  return (
    <>
      {tokenizeRules(text).map((token, index) =>
        token.kind === "term" ? (
          <strong key={index} className="cf-term" data-term={token.term}>
            {token.text}
          </strong>
        ) : (
          <Fragment key={index}>{token.text}</Fragment>
        ),
      )}
    </>
  );
}
