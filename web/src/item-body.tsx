// Agent prose is Markdown whether it arrived through /api/reports or came from
// a stopped run's captured message. Only the context drawer keeps raw output.

import { Markdown } from "./markdown";
import type { Item } from "./types";

type BodyItem = Pick<Item, "body" | "summary" | "structured" | "kind">;

export function ItemBody({ item }: { item: BodyItem }) {
  if (!item.structured) {
    return (
      <>
        {item.summary ? <Markdown text={item.summary} className="body-text" /> : null}
        <Markdown text={item.body} className="body-text" />
      </>
    );
  }
  return (
    <>
      {/* A PR item's summary is its gate status, already in the badge above. */}
      {item.summary && item.kind !== "pr" ? <Markdown text={item.summary} className="body-text" /> : null}
      {item.body && item.body !== item.summary ? <Markdown text={item.body} className="body-text" /> : null}
    </>
  );
}
