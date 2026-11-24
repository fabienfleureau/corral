## Epic request

This task comes from the generic request input on an epic (`epic_id`: `{epic_id}`).
First determine the user's intent from their request, then act accordingly:

- **Question, analysis or plan**: inspect the epic, its design, its Jira tickets, its Corral tasks, classic tasks and the workspace, then answer directly in your `done` report without making changes.
- **Change to the epic**: inspect the epic first, then apply the requested change (resync from Jira, revise the epic design, update epic defaults, update the epic agent settings/guidance, or trigger an epic agent cycle).
- **Action on an existing task** (epic or classic): inspect the tasks first, then update, instruct, launch or archive the relevant task(s) as requested.
- **Create Corral tasks**: inspect available repos and favorites/harnesses first, check existing tasks to avoid duplicates, and create either **epic tasks** (linked to this epic) or **classic tasks** (standalone) in the right repo with the right agent. Keep created tasks open unless the user explicitly asked to launch or dispatch them.
- **Code changes**: do not edit source code directly in this task unless explicitly asked; prefer creating a scoped `code` task (epic or classic) in the right repository so it goes through the normal worktree and PR flow.

### Interacting with Corral

Authenticate every request with `-H "Authorization: Bearer {corral_token}"` and build JSON payloads safely (e.g. with `jq` or `node -e`) — never interpolate untrusted Jira or task text into shell commands:

- Inspect this epic (design, Jira tickets, tasks, links, agent): `GET {corral_url}/api/epics/{epic_id}`
- Update epic defaults (`favorite_name`, `repo_path`): `PATCH {corral_url}/api/epics/{epic_id}`
- Resync epic from Jira: `POST {corral_url}/api/epics/{epic_id}/sync`
- Publish a revised epic design (`{body, reason}`): `POST {corral_url}/api/epics/{epic_id}/design`
- Configure or run the autonomous epic agent: `PUT {corral_url}/api/epics/{epic_id}/agent` · `POST {corral_url}/api/epics/{epic_id}/agent/run`
- Create an **epic task** (`{title, prompt, repo_path, favorite|target, agent?, model?, reasoning?, kind?, jira_key?, base_branch?}`): `POST {corral_url}/api/epics/{epic_id}/tasks`
- Launch a ready epic ticket task: `POST {corral_url}/api/epics/{epic_id}/tasks/<taskId>/launch`
- List classic and epic tasks, or read a task's history: `GET {corral_url}/api/tasks` · `GET {corral_url}/api/tasks/<taskId>/events`
- Create a **classic task** (`{title, prompt, repo_path, kind?, target?, agent?, model?, reasoning?, base_branch?}`): `POST {corral_url}/api/tasks`
- Update or assign a task (`repo_path` as registered repo name or absolute path, `favorite` or `target`/`agent`/`model`/`reasoning`, `base_branch`, `title`, `prompt`, `status`), instruct, or dispatch it: `PATCH {corral_url}/api/tasks/<taskId>` · `POST {corral_url}/api/tasks/<taskId>/instruct` · `POST {corral_url}/api/tasks/<taskId>/dispatch`
- List registered repos and configured favorites/harnesses: `GET {corral_url}/api/repos` · `GET {corral_url}/api/config`

If the request is ambiguous or asks for a destructive or irreversible action, report a `question` and wait instead of guessing.
