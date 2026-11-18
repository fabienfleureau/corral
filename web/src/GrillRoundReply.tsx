// One interview question at a time. Slides are a native horizontal scroller:
// buttons and markers only move it, so swipe and keyboard scrolling still work.

import { useEffect, useRef, useState } from "react";
import type { GrillQuestion } from "./grill-format";
import { Markdown } from "./markdown";

function nearestSlide(track: HTMLElement): number {
  const center = track.scrollLeft + track.clientWidth / 2;
  let best = 0;
  let distance = Infinity;
  for (let i = 0; i < track.children.length; i++) {
    const slide = track.children[i] as HTMLElement;
    const delta = Math.abs(slide.offsetLeft + slide.offsetWidth / 2 - center);
    if (delta < distance) {
      distance = delta;
      best = i;
    }
  }
  return best;
}

export function GrillRoundReply({ questions, disabled, onSend }: {
  questions: GrillQuestion[];
  disabled: boolean;
  onSend: (answers: Record<string, string | string[]>) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [index, setIndex] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const trackRef = useRef<HTMLDivElement | null>(null);
  const prevRef = useRef<HTMLButtonElement | null>(null);
  const nextRef = useRef<HTMLButtonElement | null>(null);
  const frame = useRef<number | null>(null);
  const firstRender = useRef(true);

  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);

  const currentId = questions[index]?.id ?? "";
  // Announce changes, but stay quiet on mount so the page load is not spoken.
  // Depend on values, not the questions array: Inbox rebuilds it on each render.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const timer = setTimeout(() => {
      setAnnouncement(`Question ${index + 1} of ${questions.length}: ${currentId}`);
    }, 150);
    return () => clearTimeout(timer);
  }, [index, currentId, questions.length]);

  const answers = Object.fromEntries(questions.map((q) => {
    const selected = values[q.id] ?? [];
    const text = custom[q.id]?.trim();
    return [q.id, q.multiple ? [...selected, ...(text ? [text] : [])] : text || selected[0] || ""];
  }));
  const answered = (id: string) => {
    const answer = answers[id];
    return Array.isArray(answer) ? answer.length > 0 : Boolean(answer);
  };
  const complete = questions.every((q) => answered(q.id));

  const goTo = (target: number) => {
    const next = Math.max(0, Math.min(questions.length - 1, target));
    if (next === index) return;
    if (next === 0 && document.activeElement === prevRef.current) nextRef.current?.focus();
    if (next === questions.length - 1 && document.activeElement === nextRef.current) prevRef.current?.focus();
    const track = trackRef.current;
    const slide = track?.children[next] as HTMLElement | undefined;
    if (track && slide) {
      const left = slide.getBoundingClientRect().left - track.getBoundingClientRect().left + track.scrollLeft;
      track.scrollTo({ left });
    }
    setIndex(next);
  };

  const onScroll = () => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const track = trackRef.current;
      if (track) setIndex(nearestSlide(track));
    });
  };

  return <div className="grill-reply" role="region" aria-roledescription="carousel" aria-label="Interview questions">
    <div className="grill-reply-head">
      <span className="grill-progress">Question {index + 1} of {questions.length}</span>
      <div className="grill-nav">
        <button ref={prevRef} type="button" className="btn" onClick={() => goTo(index - 1)} disabled={index === 0} aria-label="Previous question">← Previous</button>
        <button ref={nextRef} type="button" className="btn" onClick={() => goTo(index + 1)} disabled={index === questions.length - 1} aria-label="Next question">Next →</button>
      </div>
    </div>
    <div className="grill-markers" role="group" aria-label="Choose a question">
      {questions.map((q, i) => <button type="button" key={q.id}
        className={`grill-marker${answered(q.id) ? " is-answered" : ""}`}
        aria-current={i === index ? "true" : undefined}
        aria-label={`Go to ${q.id}, question ${i + 1} of ${questions.length}${answered(q.id) ? ", answered" : ""}`}
        onClick={() => goTo(i)}>{q.id}{answered(q.id) ? " ✓" : ""}</button>)}
    </div>
    <div className="grill-track" ref={trackRef} onScroll={onScroll}
      role="group" aria-label="Question cards" tabIndex={0}>
      {questions.map((q, i) => <div className="grill-slide" key={q.id}
        role="group" aria-roledescription="slide" aria-label={`${q.id}, question ${i + 1} of ${questions.length}`}>
        <div className="grill-slide-inner">
          <div className="grill-slide-head">
            <span className="chip chip-static">{q.id}</span>
            <span className="muted">{i + 1} / {questions.length}</span>
          </div>
          <Markdown text={q.prompt} className="grill-prompt" />
          {q.recommendation ? <p className="grill-recommendation"><strong>Recommendation:</strong> {q.recommendation}</p> : null}
          <fieldset disabled={disabled}>
            <legend className="visually-hidden">Answers for {q.id}</legend>
            {(q.recommendation ? ["Yes — accept recommendation", ...q.choices] : q.choices).map((choice) => <label className="grill-choice" key={choice}>
              <input type={q.multiple ? "checkbox" : "radio"} name={q.id}
                checked={(values[q.id] ?? []).includes(choice)} onChange={(event) => {
                  setValues((prev) => ({ ...prev, [q.id]: q.multiple
                    ? event.target.checked ? [...(prev[q.id] ?? []), choice] : (prev[q.id] ?? []).filter((v) => v !== choice)
                    : [choice] }));
                  if (!q.multiple) setCustom((prev) => ({ ...prev, [q.id]: "" }));
                }} />{choice}
            </label>)}
            <label className="grill-custom"><span>{q.multiple ? "Additional answer" : "Custom answer"}</span>
              <input value={custom[q.id] ?? ""} onChange={(event) => {
                setCustom((prev) => ({ ...prev, [q.id]: event.target.value }));
                if (!q.multiple) setValues((prev) => ({ ...prev, [q.id]: [] }));
              }} />
            </label>
          </fieldset>
        </div>
      </div>)}
    </div>
    <div className="grill-submit-row">
      <button className="btn btn-primary" type="button" disabled={disabled || !complete}
        onClick={() => void onSend(Object.fromEntries(questions.map((q) => [q.id, answers[q.id]])))}>
        Send answers &amp; acknowledge
      </button>
      <span className="muted">{questions.filter((q) => answered(q.id)).length} / {questions.length} answered</span>
    </div>
    <p className="visually-hidden" role="status" aria-live="polite">{announcement}</p>
  </div>;
}
