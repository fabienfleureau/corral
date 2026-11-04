import { useState } from "react";
import type { Question } from "./question-reply";

export function QuestionReply({ questions, disabled, onSend }: {
  questions: Question[];
  disabled: boolean;
  onSend: (answers: Record<string, string | string[]>) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const answers = Object.fromEntries(questions.map((q) => {
    const selected = values[q.id] ?? [];
    const text = custom[q.id]?.trim();
    return [q.id, q.multiple ? [...selected, ...(text ? [text] : [])] : text || selected[0] || ""];
  }));
  const complete = Object.values(answers).every((answer) => answer.length > 0);
  return <form className="question-reply" onSubmit={(event) => { event.preventDefault(); if (complete && !disabled) void onSend(answers); }}>
    {questions.map((q) => <fieldset key={q.id} disabled={disabled}>
      <legend>{q.prompt}</legend>
      {q.choices.map((choice) => <label className="question-choice" key={choice}>
        <input type={q.multiple ? "checkbox" : "radio"} name={q.id}
          checked={(values[q.id] ?? []).includes(choice)} onChange={(event) => {
            setValues((prev) => ({ ...prev, [q.id]: q.multiple
              ? event.target.checked ? [...(prev[q.id] ?? []), choice] : (prev[q.id] ?? []).filter((v) => v !== choice)
              : [choice] }));
            if (!q.multiple) setCustom((prev) => ({ ...prev, [q.id]: "" }));
          }} />{choice}
      </label>)}
      <label className="field"><span>{q.multiple ? "Additional answer" : "Custom answer"}</span>
        <input value={custom[q.id] ?? ""} onChange={(event) => {
          setCustom((prev) => ({ ...prev, [q.id]: event.target.value }));
          if (!q.multiple) setValues((prev) => ({ ...prev, [q.id]: [] }));
        }} />
      </label>
    </fieldset>)}
    <button className="btn btn-primary" type="submit" disabled={disabled || !complete}>Send answers & resolve</button>
  </form>;
}
