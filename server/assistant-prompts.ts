// Opening sentences of the prompts Corral sends to its own assistant command
// (`claude -p` by default). That command writes its run to the same session
// logs as the human's work, so the skills analysis recognizes these runs by
// their opener and leaves them out. Each builder starts from its constant, so
// the filter cannot drift from the prompt.

export const SUMMARIZE_OPENER = "You are a helper inside a personal inbox app.";
export const IMPROVEMENT_OPENER = "Analyze this Corral activity and propose practical engineering process improvements for a human to review.";
export const ENGINEERING_SKILLS_OPENER = "Analyze Corral activity to suggest engineering learning opportunities for the human.";
export const SKILLS_OPENER = "Review the agent skills on this machine against how the human's coding-agent sessions used them.";

export const ASSISTANT_PROMPT_OPENERS: readonly string[] = [SUMMARIZE_OPENER, IMPROVEMENT_OPENER, ENGINEERING_SKILLS_OPENER, SKILLS_OPENER];

/** True when a session's first prompt is one of Corral's own assistant calls. */
export function isAssistantPrompt(prompt: string | null): boolean {
  return prompt !== null && ASSISTANT_PROMPT_OPENERS.some((opener) => prompt.startsWith(opener));
}
