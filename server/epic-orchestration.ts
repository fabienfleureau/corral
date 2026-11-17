import { AMENDMENT_OPENER } from "./assistant-prompts.ts";

export function orchestrationPrompt(frame: string, request: string, epic: { jira_key: string; title: string }, design: string, tasks: { key: string; title: string; state: string; blockers: string[]; description?: string; repo?: string }[]): string {
  return [
    AMENDMENT_OPENER,
    "Propose a concrete orchestration plan for the human's request. Identify design changes, tasks to add or amend, dependencies and tests where relevant. Distinguish completed or running work. Do not claim to have made changes. Respond in the language of the request.",
    `Human request:\n${request.slice(0, 8000)}`,
    frame,
    `Epic: ${epic.jira_key} ${epic.title}`,
    `Current design:\n${design.slice(0, 12000)}`,
    `Tasks and blockers:\n${JSON.stringify(tasks.map((task) => ({ ...task, description: task.description?.slice(0, 1500) }))).slice(0, 30000)}`,
  ].join("\n\n");
}
