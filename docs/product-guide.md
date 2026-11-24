# Product guide

[Product overview](../README.md) · [Architecture](architecture.md) · [Contributing](../CONTRIBUTING.md)

See the [quickstart](../README.md#quickstart) for prerequisites and first launch.

## Features


- **Task backlog** — create tasks in the web UI or `corral add`, or import from
  **Jira** (one-way pull via JQL filter + manual search, deduped by issue key).
  Jira subtasks group under their parent; when all children resolve, the parent's
  **Mark done** CTA lights up. A task imported from Jira also drives its ticket's
  **status**, forward only: dispatch → `In Progress`, PR/MR opened → `Code Review`,
  PR shown by Corral as `ready to merge` (gate passed **and** a human approved it)
  → `Ready to merge`, merged → `Done` (names configurable per workflow).
- **Agent control (MCP)** — an agent can create an open task, ask what waits
  next, and give an instruction on a task by id or title. Three tools are served
  over the authenticated HTTP API, with one-line answers so a voice agent can
  read them aloud. Creating a task never dispatches it; an instruction lands in
  the prompt of an open task or in the session of a running one. Setup and
  contract: [API.md](../API.md#agent-control-mcp), decision:
  [ADR 0004](adr/0004-agent-control-mcp.md).
- **Dispatch** — one click. Pick a harness (Claude/Codex/OpenCode) and optionally
  pin an agent, model and reasoning level; blank means omnigent smart-routes.
  Each task gets a fresh git worktree created by omnigent (opt out per task); a
  `review` or `spec` task runs in place, with no branch. Automatic branches are
  `<jira-key>/<short-slug>` for a ticket, `corral/<short-slug>-<task-id>`
  otherwise: whole words only, no mid-word truncation. Antigravity tasks run
  without tool-approval prompts because they have no human at the terminal
  ([ADR 0014](adr/0014-antigravity-permission-bypass.md)).
- **Cleanup** — when a task is done or archived, Corral asks omnigent to remove
  its worktree and local branch. An open PR keeps them until the PR is merged or
  closed, because the review loop still needs the branch. A periodic pass retries
  leftovers and failed removals; the branch name stays on the task as history
  ([ADR 0012](adr/0012-terminal-tasks-release-worktrees.md)).
  **Favorites** save a harness/model/reasoning combination, scoped to a
  professional or personal repo context. A favorite on an OpenCode DeepSeek
  model shows a pale red **2× peak** tag during its doubled-rate peak hours
  (01:00–04:00 and 06:00–10:00 UTC, Mon–Fri); the favorite stays gray.
  An optional **pre-PR review step** runs
  a named reviewer (`reviewers` in the config) before the PR opens: a command, or
  a **delegate** — `ocr-claude` / `ocr-codex` hand the review to an
  [`ocr delegate`](https://github.com/alibaba/open-code-review) sub-agent on
  that harness, so a Claude task can be reviewed on the Codex quota and the other
  way round. Delegates need the Claude harness and no explicit agent.
- **Prompt attachments** — drop files on the New task prompt, paste a screenshot
  or pick them: PNG, JPEG, GIF and WebP images, PDFs, and text or code files (up
  to 10 files, 25 MB). They are stored with the task and sent to the agent with
  the first prompt, as session files omnigent hands to the harness.
- **Review tasks** — a task of kind `review` points at someone else's PR/MR and
  runs on any configured harness, Claude or Codex included. The agent reads the
  `fabien-reviewer` skill by name when the harness offers it, otherwise from its
  local skill file. It drafts its review, and publishes only after you approve it
  in the inbox. The task then shows whether the comments were posted:
  `comments published` once you answered the publish question and the agent
  reported done, `comments not published` when you answered `none` or archived
  or acknowledged the question without replying. Corral does not ask again.
- **Action tasks** — the Epic page can create a task of kind `ops`: the agent works
  in the chosen folder with no worktree, branch or PR and reports back to the
  inbox. The folder may hold several repos or none, so it fits requests that need
  context but no source change.
- **Multi-repo spec tasks** — a task of kind `spec` points at a folder holding
  git repos, one sub-project per directory. The agent reads them and reports a
  **plan**: the contract between the sub-projects (each REST endpoint, event,
  schema or config key that crosses a repo boundary, with its owner, consumers
  and delivery order) plus up to 12 sub-tasks, one per repo. The plan lands in
  the inbox; **Approve plan** creates the code tasks, re-validating every path
  (inside the folder, a repository root, no duplicate). Each child's prompt
  carries the contract, so the repos cannot drift apart. A spec task reads only:
  no branch, no commit, no PR. Children show a `from <spec title>` badge.
- **Epics** — a Jira epic and its tickets as an ordered piece of work, across one or
  several repos, over several days. Import it by key on the Epics page: each child
  ticket becomes a task, Jira "blocks / is blocked by" links become dependencies, and a
  `Repo:` line in the ticket picks the repo. The page shows what is blocked, ready to
  launch, running, PR-ready or merged, and a summary such as "3/7 merged · 2 testable".
  A task whose prerequisites are ready waits on the Epics page: nothing is added to the
  inbox and nothing runs until you click **Launch** there. In the same repo it stacks on
  its prerequisite's branch only when launched. Decision: [ADR 0002](adr/0002-epic-tasks-start-from-epic-page.md).
  The **Ask about this epic** input takes any free-form request — a question, a change to the epic or its design, an action on an existing task, or creating epic or classic Corral tasks — and creates an open `ops` task tracked on the Tasks page, outside the Jira board.
  Its prompt starts with the epic's Jira ticket, summary and link, and at dispatch it receives `skills/epic-request.md` so the agent can determine your intent and interact with the epic and Corral tasks through the Corral API.
  A Jira ticket marked **Killed** is cancelled, not merged: a resync hides it from the Epics page, removes it from the summary and no longer lets it block other tickets. A task whose prerequisite was killed keeps a note on the epic.
  Each epic also has an optional **Autonomous implementation agent** (configured with a working directory, favorite, optional hourly/daily cadence, and persistent context — mirroring KPI monitoring). When run, it discovers implementation steps autonomously, operates through real Corral tasks like a human (creating tasks in the right repository and agent, launching/dispatching unblocked tasks, updating task and Jira statuses, instructing running tasks and refreshing PRs), runs E2E tests when possible, reports problems, missing specs/information and clarification requests on the Epic page, and keeps durable memory in `.corral/epic-<key>-memory.md`. Use the **One-time instruction** form on the Epic page to answer clarifications or steer a single run without saving the message into persistent settings; the agent addresses it and folds durable answers into its memory.
  A ticket's `Préconditions` are checked by the agent before it starts. The epic's
  **design** is versioned: publishing a revision writes the current version into the
  Jira epic, marks started tasks **impacted**, and an assistant proposes an
  **amendment** per unstarted task, which you apply (written to the Jira ticket) or
  reject from the inbox. Jira stays the source of truth; Corral only writes its own
  delimited `[corral:begin:…]` blocks. The `epic-brainstorm` skill turns a
  brainstorming into an epic in that format. Vocabulary: [`GLOSSARY.md`](../GLOSSARY.md),
  decision: [ADR 0001](adr/0001-jira-source-of-truth-for-epics.md).
- **Question inbox** — dispatched agents are given `skills/question-report.md`,
  which tells them to POST a clean question via `$CORRAL_URL/api/reports`. Structured
  question batches and permission requests are answered from the item. Acknowledge,
  snooze (1h, 4h, tomorrow) and archive sit on top. Archiving a task from the
  inbox also archives its session in Omnigent when it has one; the session leaves
  its repository project, which Corral deletes once no live session remains in
  it (a renamed or configured project is kept). A run that stops without a
  report — a transient error, a mid-run crash, or a plain closing message — is
  retried automatically with backoff (default: 2 retries at 15s / 60s for errors
  and crashes, 1 nudge at 15s for silent stops, 0 retries for fatal auth/billing
  errors), then surfaced as a question item carrying that last message instead
  of sitting "in progress" forever ([ADR 0016](adr/0016-stopped-agent-retry-policy.md)). Both
  reported and captured item text render as Markdown; only the raw context
  drawer stays verbatim.
  The **In progress** tab lists only dispatched tasks whose Omnigent session is
  not stopped, marking each with its run state: **agent running** (working or
  waiting on you) or **agent status unknown** when no session state is
  available. Tasks whose session went idle, finished, or failed leave **In
  progress**.
- **PR loop** — Corral watches each task's PR/MR. Review comments, merge
  conflicts, and failing CI checks (bounded to 2 automatic attempts per head
  commit) are pushed back to the agent (`skills/pr-loop.md`). The item turns
  **green** only when threads are answered or resolved, checks pass and the PR
  is mergeable; a fresh PR is **orange** until automated reviews pass. An
  observe-only **risk triage** badge (`routine skim` or `deep review`,
  configurable per repo in `.corral/triage.json`, [ADR 0019](adr/0019-pr-risk-triage-observe-only.md))
  highlights review depth without altering readiness or approvals. **Force
  refresh** re-checks one PR on demand. A merged PR completes its task and
  archives its items (see the **Archived** tab).
- **Pull Requests page** — your own PRs/MRs, review requests, and colleagues' open
  PRs in repos where you can push, on GitHub and GitLab, grouped by repo and
  colored by readiness.
- **Select → new task** — select a passage anywhere (an inbox report, typically)
  and a *New task* action hands it to the Tasks page as the prefilled prompt.
- **Task history** — every task carries an append-only log of what happened to it:
  creation, edits, state changes, each prompt sent to the agent, Jira status
  moves, PR milestones and agent questions. Open it from the inbox or the tasks
  list (`GET /api/tasks/:id/events`).
- **Sessions** — the omnigent sessions Corral knows about, with a link out to each.
- **Usage** — Claude Code, Codex and OpenCode Go spend from local session data,
  quota for those agents and Google (from Antigravity), cost per done task, PR
  additions, and GitHub/GitLab API rate limits for the PR loop. The Over time chart splits cost or tokens by agent
  or by model; `#/usage?range=7d&group=model&metric=tokens` opens the model view.
- **Model facts** — a shipped catalog of model facts (retention, quota, cost,
  benchmark scores) shows indicators on the task form.
- **Self-improvement** (`#/improve`) — three analyses, each on demand or on a
  schedule, that dispatch read-only agent tasks in a selected repository and post
  a digest to the inbox. The *improvement analysis* reviews recent
  task and PR activity. The *engineering skills analysis* suggests learning topics
  and exercises from Corral activity, without inferring proficiency from delegated
  work. The *skills analysis* compares the skills installed on
  this machine with the last 90 days of Claude Code and Codex sessions, flags
  skills that look obsolete and proposes new ones with draft `SKILL.md` text.
- **Notifications** — in-app + desktop, for new actionable items only.
- **Metrics** — every event (created/dispatched/replied/resolved/…) is recorded
  (`/api/metrics/summary`).
- **Offline mode** — a service worker caches the app shell and the last-known API
  responses, so the inbox opens on a flaky connection showing cached data. An
  offline banner shows when you are disconnected.
- **Layout** — the sidebar collapses to icons, and the sidebar and the inbox list
  resize by dragging the divider or with arrow keys (Shift for bigger steps,
  Enter to reset); widths and the collapsed state persist per browser.

Pages are hash-routed: `#/inbox`, `#/tasks`, `#/pulls`, `#/sessions`, `#/usage`,
`#/improve`, `#/settings`, `#/errors`.

## Development and CLI

Dev mode (API + Vite with hot reload):

```sh
npm run serve            # terminal 1
npm run dev:web          # terminal 2 → http://localhost:5173
```

Server code changes need a server restart; `npm run build` is enough for UI
changes.

CLI (talks to the running server):

```sh
node server/cli.ts add "Fix flaky upload test" --repo ~/work/api --prompt "…" --target claude
node server/cli.ts status
```

An agent can use the same server through MCP. Register the HTTP endpoint once;
it uses the Corral token and needs no second process or dependency:

```sh
token=$(node -p "JSON.parse(require('node:fs').readFileSync(process.env.HOME + '/.config/corral/config.json')).token")
claude mcp add --transport http corral http://127.0.0.1:4787/api/mcp \
  --header "Authorization: Bearer $token"
```

Then say, for example, "create a Corral task to fix the flaky upload test",
"what's next in Corral?" or "tell the upload test task to cover retries". The
agent sees `corral_create_task`, `corral_next` and `corral_instruct`; each tool
answers in one short line. It cannot dispatch a task, answer an inbox question
or merge a PR. Use a LAN address only if you accept that anyone on that network
with the token can use the whole API, not just these tools.

## Prompts

Corral tells each agent what to do through short prompt conventions. **Every
prompt it sends — the injected `skills/*.md` conventions, the PR-loop messages,
and Corral's own assistant calls — is listed in [`docs/prompts.md`](prompts.md)**:
what it says, when it is sent, and which placeholders get substituted. Start
there before changing agent behaviour.

A task of kind `review` gets `skills/review.md` instead of the finish flow and
the PR loop (it must not commit or push); a `spec` task gets `skills/spec.md` and
reports a plan instead of a PR.

## Configuration

`~/.config/corral/config.json` (generated on first run). The Settings page edits
the common keys; the file wins on restart.

| Key | Default | |
|---|---|---|
| `port` / `host` | `4787` / `127.0.0.1` | localhost; shared access token, no per-user authorization |
| `token` | generated | shared by web cookie + CLI + agent reports |
| `omnigent` | `{baseUrl: http://127.0.0.1:6767, token, hostId, agents, localProviders}` | the agent backend; `agents` maps a harness id to an omnigent registration/harness, `localProviders` lists local model servers to probe |
| `agents` | `claude`, `codex`, `opencode` | harnesses offered in the UI |
| `assistant` | `["claude","-p","{prompt}"]` | Corral's own LLM calls (summaries, improvement analysis) |
| `jira` | `{baseUrl, email, token, jql, statuses?}` | email + API token (Basic); `statuses` maps stage → Jira status name (`to_do`, `in_progress`, `code_review`, `ready_to_merge`, `done`), blank disables a stage |
| `favorites` | `[]` | saved harness/agent/model/reasoning combos, with a context and an optional reviewer |
| `reviewers` | `cubic`, `ocr`, `ocr-claude`, `ocr-codex` | named pre-PR reviews: `{name, command}` (`{base_branch}` is substituted) or `{name, delegate: "claude" \| "codex"}`. The defaults only apply while `reviewers` is absent from your file: once saved from Settings the list is yours, so add `{"name": "ocr-codex", "delegate": "codex"}` by hand. Needs the `ocr` CLI (open-code-review ≥ 1.9, for `--format json`) on the host |
| `models` | `{}` | overrides merged over the shipped model facts catalog |
| `usage.prices` | `{}` | price overrides (USD/MTok) by model id or `prefix*` |
| `stoppedRetry` | `{maxAttempts: 2, delaysSec: [15, 60], silentStopAttempts: 1}` | automatic retries/nudges when a dispatched task's session stops without reporting before escalating to the inbox |
| `workspaceRoots` | `~/workspace` | directories scanned for git repos |
| `worktreesDir` | `~/.herdr/worktrees` | legacy; omnigent now creates worktrees |

Env overrides: `CORRAL_PORT`, `CORRAL_HOST`, `CORRAL_TOKEN`, `CORRAL_DATA_DIR`.

## Interview tasks

Choose **Grill me** to interview about an idea, and tick **With docs** when the agent should also record domain decisions while it interviews. The working directory can be any folder or git repository; registered repos are suggested. Without docs, the agent runs in place and changes no files. With docs, a git repo gives the agent a worktree and a PR for the documentation changes; a plain folder is edited in place and reported in the inbox without a PR. [ADR 0009](adr/0009-interview-working-directory.md). The inbox shows an **Answer questions** button on each reported round; the card opens in a modal over the detail pane. Use **Previous** / **Next**, the question markers, or swipe sideways to move between questions. Each card scrolls on its own if the question or its choices are long. Answer every question, then send the round together; the modal closes and the agent continues with the next round. Acknowledged rounds keep a **View questions** button for a read-only look at the card.

## Roadmap

- **next** — routing suggestions (quota headroom + editable rules)
- **later** — auto-dispatch queue, agent-fed intake, remote machines, fuller
  Jira sync (comments back)

## KPI monitoring

Open [KPI](#/kpis) and choose **KPI 1** or **KPI 2**. Both start empty.
Give the metric a name and describe its calculation, what to include and its
reporting window. Add a display unit and references to expected connectors,
dashboards or queries when known. Save the definition to name the tab.

Choose the working directory the agent reads from. Any absolute folder works,
git repository or not; the session runs there directly, without a worktree.
Registered repositories are suggested and decide which favorites are available
(an unregistered folder uses professional favorites). KPI sessions join the same
Omnigent project as other sessions for that folder; an unregistered folder uses
its path as the project name. Pick a favorite to supply
the harness, agent, model and reasoning; add one in Settings if needed, with
read-only connector access. Save the settings and use **Run now**, or set
**Hourly** or **Daily** for automatic analysis. On a wide screen the settings
stay beside the report: drag the divider, or focus it and use the arrow keys,
to change the pane width; **Save settings** and **Run now** stay in view while
you edit. On a narrow screen the form moves below the report. Scheduling
starts off.
Corral and the Omnigent runner must stay online for unattended cycles. After
a restart Corral resumes checking the active session or starts a due cycle.

Each tab shows the last report, measurement window and evidence, missing
data, product questions and proposals. Report text uses Markdown, so agent
findings keep their headings, lists, emphasis, code and links. The last
sourced value stays visible if a newer cycle lacks a measurement. Use **Persistent context** in the settings pane for standing product context or constraints saved across every cycle, and use **One-time instruction** to answer product questions or steer a single analysis without saving the message into settings; the agent addresses it and folds durable answers into its memory. The next cycle reads the prior report and research memory. The durable memory is a file in the working directory: `.corral/kpi-1-memory.md` or `.corral/kpi-2-memory.md`. Corral creates it, the agent updates it during a cycle, and the page shows a bounded copy. Once the file has notes it is the source for the next cycle.
**Draft task** opens the editable Tasks form for a proposal.

Set an optional **Goal**: a target value in the KPI unit, whether the KPI
must end at least or at most there, a deadline, and why it matters. The last
measured value becomes the baseline; without one, the next sourced measurement
does. The Goal panel shows how far the KPI is from the target, the share of the
way done since the baseline and the measurement history against the target.
Each cycle the agent says whether the KPI is on track for the deadline and
reviews the goal itself (realistic, ambitious, unrealistic or not measurable).
Clearing the target removes the goal and its baseline.

Changing the calculation or unit starts a fresh report, memory file, last measurement and measurement history for the slot.
Edits to the name, sources, product context and goal preserve the current research.

**Build team artifact** turns the saved reports into a private Claude artifact for a team update. Choose a one pager to share ahead of the meeting or slides to present live. The first four sections tell the core story — current value, evolution and why, work and impact, and next steps. You can also add goal and trajectory, data confidence, decisions needed, risks and blockers, or a short methods note; the first three are on by default. An optional audience note steers the tone. Corral starts a Claude task, and its link to the artifact appears in the inbox. Run an analysis first: with no report there is nothing to summarise. The artifact is a snapshot; build another one after the next cycle if the numbers changed.
