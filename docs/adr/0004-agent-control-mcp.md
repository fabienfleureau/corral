# Agent control is a small MCP surface over Corral's own state

Status: Proposed

A human may drive Corral from an agent, especially by voice: create a task, ask
what waits next, give an instruction on a task. The HTTP API already supports
these operations, but an agent needs a discoverable tool contract and answers
short enough to read aloud. Handing an agent the raw API token and endpoint list
would expose the whole application, including dispatch, Jira writes and inbox
replies, for a three-command job.

Corral exposes three MCP tools — `corral_next`, `corral_create_task` and
`corral_instruct` — through a stateless JSON-RPC route on the authenticated HTTP
server. Tool results are one short sentence; no task bodies, prompts or inbox
text are included. Creating a task leaves it open: starting an agent stays a
human decision. An instruction is appended to an open task's prompt or sent to
the session of a running task, and both paths are recorded in task history.

The alternative was to extend the `corral` CLI and hand an agent a skill that
describes its flags. That works in a terminal but gives a voice client no tool
schema and no clear boundary on what the agent may do. A second MCP process
would need its own config, token handling and deployment. Embedding an agent in
Corral would break the ownership split: omnigent runs agents, Corral coordinates
work ([ADR 0003](0003-record-consequential-decisions.md) covers why
boundaries like this are recorded).

The cost is a new integration surface to maintain: every new agent capability
must be a deliberate tool with a short result. The shared bearer token still
grants full API access to whoever holds it; MCP does not add a narrower
credential. Tool descriptions and the initialize `instructions` are prompts sent
to agents and are registered in [docs/prompts.md](../prompts.md).
