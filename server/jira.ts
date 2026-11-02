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
  };
}

export interface JiraTransition {
  id: string;
  name: string;
}

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

function descriptionToText(description: unknown): string {
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
      fields: "summary,description,parent,status,issuetype",
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
        fields: ["summary", "description", "parent", "status", "issuetype"],
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
      `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,parent,status,issuetype`,
    );
  }

  async transitions(key: string): Promise<JiraTransition[]> {
    const res = await this.request<{ transitions: JiraTransition[] }>(
      "GET",
      `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
    );
    return res.transitions ?? [];
  }

  /** Pick a done-ish transition if none is given. Returns the transition used. */
  async markDone(key: string, transitionId?: string): Promise<JiraTransition> {
    let id = transitionId;
    if (!id) {
      const list = await this.transitions(key);
      const done = list.find((t) => /done|résolu|resolved|finished|terminé|clos/i.test(t.name));
      if (!done) {
        throw new Error(
          `no done-like transition available for ${key}; available: ${list.map((t) => `${t.id}=${t.name}`).join(", ")}`,
        );
      }
      id = done.id;
    }
    await this.request("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
      transition: { id },
    });
    const used = { id, name: "" };
    return used;
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
