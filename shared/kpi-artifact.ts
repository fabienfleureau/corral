/** Options shared by the KPI artifact dialog and the server prompt builder. */

export const ARTIFACT_FORMATS = ["one-page", "slides"] as const;
export type ArtifactFormat = typeof ARTIFACT_FORMATS[number];

export type ArtifactAxisId = ArtifactAxis["id"];

export interface ArtifactAxis {
  id: string;
  label: string;
  /** Short description shown in the picker. */
  brief: string;
  /** Instruction sent to the agent for this section. */
  instruction: string;
  /** Core sections are always included; the rest are proposals the human picks. */
  required: boolean;
  defaultSelected: boolean;
}

export const ARTIFACT_AXES: readonly ArtifactAxis[] = [
  {
    id: "value", label: "Current value", required: true, defaultSelected: true,
    brief: "Where each KPI stands and why it matters",
    instruction: "State the latest measured value, its window, the goal when present, and why the number matters. Use the unit and the source references from the data.",
  },
  {
    id: "evolution", label: "Evolution and why", required: true, defaultSelected: true,
    brief: "Trend, dates and evidence-backed causes",
    instruction: "Show the change over time with dates. Separate what the measurements show from the explanation: name the evidence for each cause, its confidence and any alternative explanation.",
  },
  {
    id: "work", label: "Work and impact", required: true, defaultSelected: true,
    brief: "What was done and what it changed",
    instruction: "List the work completed with its supporting evidence, then the observed or expected KPI impact. Mark impact that is not yet measured as expected, not achieved.",
  },
  {
    id: "next", label: "Next steps", required: true, defaultSelected: true,
    brief: "Actions, owners, timing and expected impact",
    instruction: "Give the next actions with an owner, timing where known, expected impact and the decision each one needs. Keep them specific enough to follow up.",
  },
  {
    id: "goal", label: "Goal and trajectory", required: false, defaultSelected: true,
    brief: "Target, gap, deadline and on-track verdict",
    instruction: "Use Corral's computed progress, gap and trajectory. Include the confidence and the goal review when present; never recompute the numbers.",
  },
  {
    id: "confidence", label: "Data confidence", required: false, defaultSelected: true,
    brief: "Coverage, gaps and how much to trust the number",
    instruction: "Summarise missing fields, coverage gaps and source quality, and say how much they change the reading of the KPI.",
  },
  {
    id: "decisions", label: "Decisions needed", required: false, defaultSelected: true,
    brief: "Open product questions with a recommendation",
    instruction: "Turn open product questions into decisions for the team, with a recommended option and why. Do not invent an answer the data does not support.",
  },
  {
    id: "risks", label: "Risks and blockers", required: false, defaultSelected: false,
    brief: "What could move the KPI the wrong way",
    instruction: "Name the risks and blockers in the evidence and their possible effect on the KPI. Skip this section when the data has none.",
  },
  {
    id: "method", label: "Methods note", required: false, defaultSelected: false,
    brief: "Definition, window and sources in one short note",
    instruction: "Add a short methods note with the metric definition, measurement window and source references so colleagues can check the number.",
  },
];

/** Axes in the core story plus those selected by default in the picker. */
export const DEFAULT_ARTIFACT_AXES: ArtifactAxisId[] = ARTIFACT_AXES.filter((axis) => axis.defaultSelected).map((axis) => axis.id);

export interface KpiArtifactRequest {
  format: ArtifactFormat;
  axes: string[];
  /** Audience or emphasis supplied by the operator. */
  audience: string;
}
