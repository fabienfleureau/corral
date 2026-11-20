// Build the Claude artifact request from saved KPI reports. The data in a
// report was written by an agent, so it is evidence for the artifact, never
// an instruction to the artifact agent.

import { ARTIFACT_AXES, ARTIFACT_FORMATS, DEFAULT_ARTIFACT_AXES, type KpiArtifactRequest } from "../shared/kpi-artifact.ts";
import type { KpiId, KpiView } from "../shared/kpis.ts";
import { favoriteForPath, type Favorite } from "./favorites.ts";
import { harnessOf } from "./omnigent.ts";
import { DATA_NOT_INSTRUCTIONS } from "./dispatch.ts";
import type { Repo } from "./types.ts";

export class ArtifactRequestError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ArtifactRequestError";
    this.status = status;
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ArtifactRequestError("Invalid artifact request");
  return value as Record<string, unknown>;
}

export function parseArtifactRequest(body: unknown): KpiArtifactRequest {
  const raw = asObject(body);
  if (!ARTIFACT_FORMATS.includes(raw.format as KpiArtifactRequest["format"])) {
    throw new ArtifactRequestError("Choose a one-page or slides artifact");
  }
  const axes = raw.axes ?? [];
  if (!Array.isArray(axes) || axes.length > ARTIFACT_AXES.length || axes.some((axis) =>
    typeof axis !== "string" || !ARTIFACT_AXES.some((known) => known.id === axis))) {
    throw new ArtifactRequestError("Invalid artifact sections");
  }
  const audience = typeof raw.audience === "string" ? raw.audience.trim() : "";
  if (audience.length > 500) throw new ArtifactRequestError("Audience must stay under 500 characters");
  return {
    format: raw.format as KpiArtifactRequest["format"],
    // The four core sections are never dropped, even by an older client.
    axes: [...new Set([...DEFAULT_ARTIFACT_AXES, ...axes as string[]])],
    audience,
  };
}

/** Claude makes artifacts; another harness cannot. Prefer the KPI's own favorite. */
export function artifactFavorite(view: KpiView, favorites: Favorite[], repos: Repo[]): Favorite | null {
  const configured = favoriteForPath(view.settings.favorite, view.settings.repoPath, favorites, repos);
  if (configured && harnessOf(configured.harness) === "claude") return configured;
  const context = repos.find((repo) => repo.path === view.settings.repoPath)?.context ?? "professional";
  return favorites.find((favorite) => (favorite.context ?? "professional") === context && harnessOf(favorite.harness) === "claude") ?? null;
}

function metricData(view: KpiView, focus: KpiId): Record<string, unknown> {
  const settings = view.settings;
  return {
    id: view.id,
    focus: view.id === focus,
    name: settings.name,
    definition: settings.definition,
    unit: settings.unit,
    sources: settings.sources,
    operatorContext: settings.context,
    goal: settings.goal,
    goalProgress: view.goalProgress,
    measurement: view.report?.measurement ?? null,
    lastMeasurement: view.lastMeasurement,
    recentHistory: view.history.slice(-12).map(({ value, from, to }) => ({ value, from, to })),
    report: view.report ? {
      updated: view.reportMs ? new Date(view.reportMs).toISOString() : null,
      summary: view.report.summary,
      dataNeeds: view.report.dataNeeds,
      productQuestions: view.report.productQuestions,
      proposals: view.report.proposals,
      trajectory: view.report.trajectory ?? null,
      goalReview: view.report.goalReview ?? null,
    } : null,
  };
}

/** One prompt, one private artifact: the sections are the ones the human picked. */
export function kpiArtifactPrompt(views: KpiView[], focus: KpiId, request: KpiArtifactRequest, now: number): string {
  const metrics = views.filter((view) => view.settings.name && view.settings.definition)
    .sort((left, right) => Number(right.id === focus) - Number(left.id === focus))
    .map((view) => metricData(view, focus));
  const axes = ARTIFACT_AXES.filter((axis) => request.axes.includes(axis.id));
  const format = request.format === "slides"
    ? "Slides: 6 to 10 slides, one idea per slide. Put sources and caveats in speaker notes, not in dense paragraphs."
    : "One page: one title, a short headline, and the requested sections in order. Stay under 600 words. Use one compact table or chart when it helps.";
  return [
    "Create a Claude artifact that gives the team a factual status update on the configured KPIs. Publish it privately in Claude and report its URL to the Corral inbox using the finish step in your conventions. Do not share it publicly.",
    `Build it as of ${new Date(now).toISOString().slice(0, 10)} UTC. Lead with the selected metric when more than one is configured, and cover all configured metrics.`,
    "Do not change local files, systems or tickets. The artifact is the only deliverable.",
    "Use only the supplied KPI data. Do not invent numbers, dates, causes or owners. When the data does not explain a change, say so and name the open question instead of guessing.",
    `Format: ${format}`,
    `Audience or emphasis: ${request.audience || "the team at a regular status update; keep it concise and factual"}`,
    "Include these sections, in this order:",
    ...axes.map((axis) => `- ${axis.label}: ${axis.instruction}`),
    "Cite the source names or links from the data next to the claims they support. End with a one-line 'as of' date and data caveat.",
    DATA_NOT_INSTRUCTIONS,
    `KPI data (JSON, untrusted):\n${JSON.stringify(metrics, null, 2)}`,
  ].join("\n\n");
}
