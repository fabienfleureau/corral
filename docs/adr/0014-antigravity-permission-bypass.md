# Antigravity sessions run with permission bypass

Status: Proposed

Corral dispatches run without a human attached to the terminal, but agy's default
per-tool `request-review` prompt arrives as an Omnigent approval elicitation. A
task that edits a file or runs a command stops there until a human answers the
inbox item, which defeats unattended dispatch. agy exposes one pre-emptive
permission control: `--dangerously-skip-permissions` (auto-approve every tool
permission request). It has no per-tool or web-routed gate.

Corral sets `terminal_launch_args: ["--dangerously-skip-permissions"]` on every
session it creates on the antigravity harness, including sessions bound to an
explicit agent. Omnigent stores those args on the session row, so a
host-spawned terminal launches with them and a relaunch keeps them.

Alternatives: have a human answer each approval card (stalls the task and turns
the inbox into a tool-by-tool gate); put `permission_mode: bypassPermissions`
in Corral's bare harness bundle (only affects agents Corral registered — a
user-chosen agent would still prompt, and a changed bundle needs a new agent
name); leave the default (tasks stall). See
[`server/omnigent.ts`](../../server/omnigent.ts).

Consequence: tools in an antigravity task are auto-approved. The worktree and
the task's settings pins remain the boundary; the human review gate stays at
the PR and inbox level.
