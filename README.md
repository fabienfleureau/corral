# Corral

**Delegate the work. Keep the decisions.**

Corral gives developers using coding agents one inbox for questions, approvals,
and pull requests. Send a task to Claude Code, Codex, OpenCode, or Antigravity;
come back when there is something to decide or review.

![Corral demo: the inbox, task history, a multi-repo plan diff, PRs, a new task, epics, pull requests, and KPI monitoring](docs/demo.gif)

## From a task to a reviewed change

Running several agents creates work of its own: following sessions, answering
questions, tracking tickets, and checking whether a PR is ready. Corral brings
those handoffs together so you can follow the work across repositories.

1. **Capture the work.** Create a code, review, multi-repo spec, or interview
   ("Grill me") task, or import a Jira ticket. Pick a repository (or folder),
   harness, or saved favorite; model, reasoning, and pre-PR review settings are
   optional.
2. **Dispatch.** The agent works in an isolated git worktree managed by
   omnigent. Questions, interview rounds, and permission requests arrive in your
   inbox; stopped runs retry automatically before escalating.
3. **Review the result.** Corral checks PR threads, checks, and mergeability.
   Review comments and conflicts go back to the agent; you review and merge.
4. **Close the loop.** A merged PR completes the task, archives its inbox items,
   and releases its worktree and local branch. Task history keeps every prompt,
   question, and milestone accessible.

Beyond single tasks, **Jira epics** organize tickets, dependencies, versioned
designs, and an optional autonomous implementation agent that proposes and
creates tasks as blockers clear. **KPI monitoring** runs scheduled analyses with
durable research memory, goals, and private Claude status artifacts. GitHub and
GitLab PRs share one listing, including review requests. See the
[product guide](docs/product-guide.md) for the full workflow.

## Built around human review

- **An inbox for decisions:** structured questions, interview rounds, annotated
  multi-repo plan revisions with diff view, snoozing, and links to the
  underlying agent sessions.
- **A visible readiness gate:** a fresh PR stays orange until automated reviews
  pass. Green requires answered or resolved threads, passing checks, and a
  mergeable branch. Human approval remains a separate step.
- **Work across repositories:** per-task worktrees (cleaned up when tasks
  finish), multi-repo specification tasks, Jira epic dependencies, and an MCP
  endpoint (`POST /api/mcp`) for external or voice agents to create tasks and
  check what waits without dispatching or merging.
- **Local context and quotas:** SQLite stores work and history; sidebar rings
  and usage views track Claude Code, Codex, OpenCode Go, and Google
  (Antigravity) quotas and spend from local data. Agent backends and connected
  platforms still make network calls.

Corral owns work coordination. **omnigent owns agent execution**, sessions,
worktrees, and model routing. Corral links out to inspect those sessions rather
than embedding a terminal or transcript viewer.

## Quickstart

Requires **Node.js 22.18 or newer** and npm. To dispatch tasks, you also need a
running **omnigent** server with the coding harnesses you want to use. PR features
use authenticated `gh` (GitHub) or `glab` (GitLab) CLIs; Jira integration is optional.

```sh
git clone https://github.com/fabienfleureau/corral.git
cd corral
npm ci
npm run build
npm run serve
```

Open the access URL printed by the server, usually
`http://127.0.0.1:4787/?token=…`. It establishes the browser cookie and removes
the token from the URL. Configure the omnigent connection and repository roots
in Settings or `~/.config/corral/config.json`; restart the server after config
file edits. Match its backend URL, token, and host registration to your omnigent
installation. The default backend URL is `http://127.0.0.1:6767`.

See the [configuration and CLI guide](docs/product-guide.md#configuration) for
connection keys, model settings, and environment overrides.

## Engineering tour

The server runs TypeScript directly on Node 22 with built-in HTTP and SQLite
modules and **no server runtime dependencies**. The UI uses React, Vite, and
plain CSS. The backend is a single process with explicit integration boundaries.

| Start here | What to inspect |
|---|---|
| [Architecture](docs/architecture.md) | System diagram, dispatch-to-review flow, ownership, trade-offs and limits |
| [Decision records](docs/adr/README.md) | Product decisions and the ADR policy applied to future changes |
| [Worker interface](server/worker.ts) | The boundary between work coordination and agent execution |
| [API contract](API.md) | HTTP endpoints and payloads |
| [Prompt registry](docs/prompts.md) | What Corral tells agents, when, and where each prompt lives |
| [Glossary](GLOSSARY.md) | Epic and design vocabulary |
| [Contributing](CONTRIBUTING.md) | Setup, verification and review expectations |

```sh
npm test
npm run typecheck
npm run build
npm run check:adr
```

Tests use temporary databases and fake integrations. The repository also includes
an isolated fixture for repeatable UI captures; see [AGENTS.md](AGENTS.md#repeatable-ui-screenshots).

## Current scope

Corral is a personal, locally hosted application under active development.
Authentication uses a shared token, with no user roles or tenant isolation.
It is not ready to expose as a public or multi-user service. Keep access URLs
and configuration credentials private; the browser may cache work data offline.

The [roadmap](docs/product-guide.md#roadmap) separates planned work from shipped
features. Every source change goes through a PR; the human reviews and merges.
