# Self-improvement menu and skills analysis

**Goal:** One sidebar page (`#/improve`) for analyses that improve how work and agents run: the existing engineering improvement analysis, moved out of Settings, and a new analysis of the human's skills against their own agent sessions.

**Decisions:**
- The page is named *Improve* (title "Self-improvement"). The analysis section leaves Settings; nothing is duplicated.
- The skills analysis proposes obsolete skills and new skills (with a draft `SKILL.md`) in an inbox digest. It never writes, edits or deletes a skill, same contract as the existing analysis.
- Usage comes only from structured invocations (Claude `Skill` tool and slash commands, Codex `SKILL.md` reads). Transcripts embed the whole skill listing, so a name match would count every skill as used.
- "Obsolete" is bounded by log coverage: the prompt says "unused since <date>", never "never used". Plugin skills are advice to disable the plugin, not to delete.
- Session prompts leave the machine through the assistant command: only the first message of each session, cleaned of Corral boilerplate (which carries the API token), redacted, truncated and capped at about 110 KB, because the prompt travels as one process argument.
- Corral's own assistant calls (`claude -p`) are logged like sessions. They are dropped by the opening sentence of each Corral prompt, kept in `server/assistant-prompts.ts` so the filter follows the prompts. `entrypoint: "sdk-cli"` is not used: other headless runs, such as MR drafting with a skill, are real usage.
- Both analyses share one persisted-schedule helper (`server/analysis-schedule.ts`), each with its own settings row.

**Steps:**
1. Extract the schedule helper; move `ImprovementAnalysis` onto it with unchanged behavior.
2. Skill inventory, session scanner and evidence builder with tests, including a listing-only transcript counting zero.
3. `SkillsAnalysis` service, `/api/skills-analysis` routes, startup timer, prompt registry row.
4. `Improve` page, sidebar entry, API.md and README.
