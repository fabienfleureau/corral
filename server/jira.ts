// Jira Cloud REST API v3 client. One-way pull plus manual write CTAs
// (mark done, add comment). Auth: email + API token (Basic).

import type { JiraConfig } from "./config.ts";

export interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    description?: unknown;
    parent?: { key: string } | null;
    status?: { name: string } | null;
    issuetype?: { name: string } | null;
    issuelinks?: JiraIssueLink[];
  };
}

/** One entry of an issue's `issuelinks`. `inwardIssue` set means "this issue
 *  <type.inward> that issue" (e.g. "is blocked by"); `outwardIssue` set means
 *  "this issue <type.outward> that issue" (e.g. "blocks"). */
export interface JiraIssueLink {
  type?: { name?: string; inward?: string; outward?: string } | null;
  inwardIssue?: { key: string } | null;
  outwardIssue?: { key: string } | null;
}

const ISSUE_FIELDS = ["summary", "description", "parent", "status", "issuetype", "issuelinks"];

/**
 * "task X is blocked by task Y" edges among `issues`, from their Blocks-type
 * links. Matched by the link's wording as well as its name: names vary per
 * instance, the inward/outward text is what Jira shows. Edges to issues outside
 * the set are dropped; both sides of a link yield the same edge, deduplicated.
 */
export function blockedByEdges(issues: JiraIssue[]): { task_key: string; blocked_by_key: string }[] {
  const keys = new Set(issues.map((i) => i.key));
  const seen = new Set<string>();
  const out: { task_key: string; blocked_by_key: string }[] = [];
  const add = (task: string, blocker: string) => {
    if (task === blocker || !keys.has(task) || !keys.has(blocker) || seen.has(`${task}>${blocker}`)) return;
    seen.add(`${task}>${blocker}`);
    out.push({ task_key: task, blocked_by_key: blocker });
  };
  for (const issue of issues) {
    for (const link of issue.fields.issuelinks ?? []) {
      const t = link.type;
      if (link.inwardIssue && (/blocked by/i.test(t?.inward ?? "") || (!t?.inward && /^blocks$/i.test(t?.name ?? "")))) add(issue.key, link.inwardIssue.key);
      if (link.outwardIssue && (/^blocks$/i.test(t?.outward ?? "") || (!t?.outward && /^blocks$/i.test(t?.name ?? "")))) add(link.outwardIssue.key, issue.key);
    }
  }
  return out;
}

export interface JiraTransition {
  id: string;
  name: string;
  /** Status the transition lands in (Jira names the step, the status is what
   *  the workflow shows — the status sync matches on this first). */
  to?: { name?: string } | null;
}

const REQUEST_TIMEOUT_MS = 10_000;

function authHeader(jira: JiraConfig): string {
  return "Basic " + Buffer.from(`${jira.email}:${jira.token}`).toString("base64");
}

function adf(text: string) {
  return {
    type: "doc",
    version: 1,
    content: text
      .split("\n\n")
      .map((para) => ({ type: "paragraph", content: [{ type: "text", text: para }] })),
  };
}

export function descriptionToText(description: unknown): string {
  if (!description) return "";
  if (typeof description === "string") return description;
  if (typeof description === "object" && "content" in (description as Record<string, unknown>)) {
    const out: string[] = [];
    const walk = (node: Record<string, unknown>) => {
      if (node.type === "text" && typeof node.text === "string") out.push(node.text);
      if (node.type === "hardBreak") out.push("\n");
      const content = node.content as Record<string, unknown>[] | undefined;
      if (Array.isArray(content)) {
        for (const child of content) walk(child);
        if (node.type === "paragraph" || node.type === "heading" || node.type === "listItem" || node.type === "codeBlock") {
          out.push("\n");
        }
      }
    };
    walk(description as Record<string, unknown>);
    return out
      .join("")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .trim();
  }
  return "";
}

export class JiraClient {
  private jira: JiraConfig;

  constructor(jira: JiraConfig) {
    this.jira = jira;
  }

  get configured(): boolean {
    return Boolean(this.jira.baseUrl && this.jira.email && this.jira.token);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.configured) throw new Error("Jira is not configured (baseUrl, email, token)");
    const res = await fetch(new URL(path, this.jira.baseUrl), {
      method,
      headers: {
        Authorization: authHeader(this.jira),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      // A wedged Jira must not stall a dispatch or a background PR sync.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err = new Error(`Jira ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** Run one JQL query. GET /search first, POST /search/jql on older-path errors. */
  private async runJql(jql: string, max: number): Promise<JiraIssue[]> {
    const params = new URLSearchParams({
      jql: jql.slice(0, 2000),
      maxResults: String(max),
      fields: ISSUE_FIELDS.join(","),
    });
    try {
      const res = await this.request<{ issues: JiraIssue[] }>("GET", `/rest/api/3/search?${params}`);
      return res.issues ?? [];
    } catch (err) {
      const status = (err as Error & { status?: number }).status;
      if (status !== 404 && status !== 410) throw err; // 404/410: endpoint moved
      const res = await this.request<{ issues: JiraIssue[] }>("POST", `/rest/api/3/search/jql`, {
        jql: jql.slice(0, 2000),
        maxResults: max,
        fields: ISSUE_FIELDS,
      });
      return res.issues ?? [];
    }
  }

  /**
   * Free text or JQL — decided by Jira, not by guessing:
   * the query runs as JQL first; only if Jira rejects the syntax (400) does it
   * become a `text ~` search.
   */
  async search(query: string, max = 25): Promise<JiraIssue[]> {
    try {
      return await this.runJql(query, max);
    } catch (err) {
      const status = (err as Error & { status?: number }).status;
      if (status !== 400) throw err;
      const textJql = `text ~ "${query.replace(/"/g, '\\"')}" ORDER BY updated DESC`;
      return this.runJql(textJql, max);
    }
  }

  async getIssue(key: string): Promise<JiraIssue> {
    return this.request<JiraIssue>(
      "GET",
      `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${ISSUE_FIELDS.join(",")}`,
    );
  }

  /** The tickets whose parent is `epicKey` (its direct children). */
  async epicChildren(epicKey: string): Promise<JiraIssue[]> {
    if (!/^[A-Za-z0-9]+-\d+$/.test(epicKey)) throw new Error(`not a Jira key: ${epicKey}`);
    return this.runJql(`parent = ${epicKey} ORDER BY key ASC`, 100);
  }

  async transitions(key: string): Promise<JiraTransition[]> {
    const res = await this.request<{ transitions: JiraTransition[] }>(
      "GET",
      `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
    );
    return res.transitions ?? [];
  }

  /** Apply one workflow transition by id. */
  async transition(key: string, transitionId: string): Promise<void> {
    await this.request("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
      transition: { id: transitionId },
    });
  }

  /** Pick a done-ish transition if none is given. Returns the transition used. */
  async markDone(key: string, transitionId?: string): Promise<JiraTransition> {
    if (transitionId) {
      await this.transition(key, transitionId);
      return { id: transitionId, name: "" };
    }
    const list = await this.transitions(key);
    const done = list.find((t) => /done|résolu|resolved|finished|terminé|clos/i.test(t.to?.name ?? t.name));
    if (!done) {
      throw new Error(
        `no done-like transition available for ${key}; available: ${list.map((t) => `${t.id}=${t.to?.name ?? t.name}`).join(", ")}`,
      );
    }
    await this.transition(key, done.id);
    return done;
  }

  async addComment(key: string, text: string): Promise<void> {
    await this.request("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
      body: adf(text),
    });
  }

  issueToTaskFields(issue: JiraIssue): {
    title: string;
    prompt: string;
    jira_key: string;
    jira_url: string;
    jira_parent_key: string | null;
    jira_status: string | null;
  } {
    const base = this.jira.baseUrl.replace(/\/$/, "");
    return {
      title: `${issue.key} ${issue.fields.summary}`,
      prompt: descriptionToText(issue.fields.description),
      jira_key: issue.key,
      jira_url: `${base}/browse/${issue.key}`,
      jira_parent_key: issue.fields.parent?.key ?? null,
      jira_status: issue.fields.status?.name ?? null,
    };
  }
}
