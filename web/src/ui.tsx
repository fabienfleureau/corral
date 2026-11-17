// Small shared presentational components.

import type { ReactNode } from "react";
import type { Item } from "./types";

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner-wrap">
      <span className="spinner" aria-hidden="true" />
      {label ? <span className="spinner-label">{label}</span> : null}
    </span>
  );
}

const iconPaths: Record<Item["kind"], ReactNode> = {
  launch: (
    <>
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </>
  ),
  question: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.2 9.2a2.8 2.8 0 0 1 5.5.9c0 1.9-2.8 2.4-2.8 4" />
      <path d="M12 17.2h.01" />
    </>
  ),
  pr: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M6 8.5V21" />
      <path d="M15 6h1a2 2 0 0 1 2 2v7.5" />
    </>
  ),
  plan: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <circle cx="12" cy="18" r="2.5" />
      <path d="M6 8.5v2a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3v-2" />
      <path d="M12 13.5v2" />
    </>
  ),
  digest: (
    <>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6" />
      <path d="M8 13h8" />
      <path d="M8 17h6" />
    </>
  ),
};

export function KindIcon({ kind }: { kind: Item["kind"] }) {
  return (
    <svg
      className={`kind-icon kind-${kind}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {iconPaths[kind]}
    </svg>
  );
}

export function ExternalLinkIcon() {
  return (
    <svg
      className="ext-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
    </svg>
  );
}

/** The Jira ticket a task was imported from. A null key/url (hand-created
 *  task) renders nothing, so callers can mount it unconditionally. Rows are
 *  clickable: the click on the link must not also select the row. */
export function JiraPill({ jiraKey, jiraUrl }: { jiraKey: string | null | undefined; jiraUrl: string | null | undefined }) {
  if (!jiraKey || !jiraUrl) return null;
  return (
    <a
      href={jiraUrl}
      target="_blank"
      rel="noreferrer"
      className="jira-pill"
      title={`Jira ticket ${jiraKey}`}
      onClick={(e) => e.stopPropagation()}
    >
      {jiraKey}
      <ExternalLinkIcon />
    </a>
  );
}

export function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`chevron ${open ? "chevron-open" : ""}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}
