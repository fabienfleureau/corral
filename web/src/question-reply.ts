export interface Question {
  id: string;
  prompt: string;
  choices: string[];
  multiple: boolean;
}

export function replyQuestions(elicitation: string | null): Question[] {
  try {
    const e = JSON.parse(elicitation ?? "null");
    // Single-choice questions already have quick replies and a text field.
    return e?.kind === "question" && Array.isArray(e.questions) && !e.field ? e.questions : [];
  } catch {
    return [];
  }
}
