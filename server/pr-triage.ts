// Observe-only PR risk triage: classifies a PR as "routine" (quick skim) or
// "deep" (deep review required) from path globs and diff size, using an
// optional `.corral/triage.json` in the repository merged over built-in
// defaults. Strictly observe-only: never alters readiness, approvals, or merge
// eligibility (ADR 0019).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type PrTriageTier = "routine" | "deep";
export type PrReviewDepth = "quick" | "standard" | "deep";

export interface PrTriagePolicy {
  /** Always "observe" — Corral never auto-approves or auto-merges PRs. */
  mode?: "observe";
  /** Glob patterns that escalate a PR to deep review. */
  deepPaths?: string[];
  /** Glob patterns considered routine when every changed file matches. */
  routinePaths?: string[];
  /** Max total lines (additions + deletions) for routine classification. */
  maxRoutineLines?: number;
  /** Max changed files for routine classification. */
  maxRoutineFiles?: number;
}

export interface PrTriage {
  tier: PrTriageTier;
  depth: PrReviewDepth;
  mode: "observe";
  reasons: string[];
  source: "policy" | "default";
}

export interface PrTriageInput {
  additions: number;
  deletions: number;
  changed_files: number;
  changed_file_paths?: string[];
}

export const DEFAULT_TRIAGE_POLICY: Required<PrTriagePolicy> = {
  mode: "observe",
  deepPaths: [
    "**/db.*",
    "**/migrations/**",
    "**/migration/**",
    "**/auth/**",
    "**/.github/workflows/**",
    "**/.gitlab-ci.yml",
    "**/package.json",
    "**/package-lock.json",
    "**/Dockerfile*",
  ],
  routinePaths: [
    "docs/**",
    "**/*.md",
    "**/*.test.*",
    "**/*.spec.*",
    "**/test/**",
    "**/tests/**",
  ],
  maxRoutineLines: 150,
  maxRoutineFiles: 5,
};

function stringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
  return out;
}

function positiveInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
}

/** Read `.corral/triage.json` from a repository when present. Malformed or
 *  missing files fall back cleanly to built-in defaults. */
export function loadRepoTriagePolicy(repoPath: string | null | undefined): {
  policy: Required<PrTriagePolicy>;
  source: "policy" | "default";
} {
  if (!repoPath) return { policy: DEFAULT_TRIAGE_POLICY, source: "default" };
  const file = join(repoPath, ".corral", "triage.json");
  if (!existsSync(file)) return { policy: DEFAULT_TRIAGE_POLICY, source: "default" };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { policy: DEFAULT_TRIAGE_POLICY, source: "default" };
    }
    return {
      source: "policy",
      policy: {
        mode: "observe",
        deepPaths: stringArray(raw.deepPaths) ?? DEFAULT_TRIAGE_POLICY.deepPaths,
        routinePaths: stringArray(raw.routinePaths) ?? DEFAULT_TRIAGE_POLICY.routinePaths,
        maxRoutineLines: positiveInt(raw.maxRoutineLines) ?? DEFAULT_TRIAGE_POLICY.maxRoutineLines,
        maxRoutineFiles: positiveInt(raw.maxRoutineFiles) ?? DEFAULT_TRIAGE_POLICY.maxRoutineFiles,
      },
    };
  } catch {
    return { policy: DEFAULT_TRIAGE_POLICY, source: "default" };
  }
}

/** Minimal glob matcher supporting `**`, `*`, and `?` over POSIX repo paths. */
export function matchGlob(pattern: string, filePath: string): boolean {
  const normPath = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const normPat = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  let re = "^";
  for (let i = 0; i < normPat.length; i++) {
    const c = normPat[i];
    if (c === "*" && normPat[i + 1] === "*") {
      if (normPat[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  re += "$";
  return new RegExp(re).test(normPath);
}

/** Classify a PR into routine vs. deep review (observe-only). */
export function classifyPrTriage(
  pr: PrTriageInput,
  opts: { repoPath?: string | null; policy?: PrTriagePolicy; source?: "policy" | "default" } = {},
): PrTriage {
  const loaded = opts.policy
    ? {
        policy: {
          mode: "observe" as const,
          deepPaths: opts.policy.deepPaths ?? DEFAULT_TRIAGE_POLICY.deepPaths,
          routinePaths: opts.policy.routinePaths ?? DEFAULT_TRIAGE_POLICY.routinePaths,
          maxRoutineLines: opts.policy.maxRoutineLines ?? DEFAULT_TRIAGE_POLICY.maxRoutineLines,
          maxRoutineFiles: opts.policy.maxRoutineFiles ?? DEFAULT_TRIAGE_POLICY.maxRoutineFiles,
        },
        source: opts.source ?? "policy",
      }
    : loadRepoTriagePolicy(opts.repoPath);

  const { policy, source } = loaded;
  const files = (pr.changed_file_paths ?? []).filter((f) => typeof f === "string" && f.length > 0);
  const totalLines = Math.max(0, pr.additions) + Math.max(0, pr.deletions);
  const fileCount = Math.max(0, pr.changed_files);
  const reasons: string[] = [];

  const matchedDeep = files.filter((f) => policy.deepPaths.some((pat) => matchGlob(pat, f)));
  if (matchedDeep.length > 0) {
    const sample = matchedDeep.slice(0, 2).join(", ");
    const extra = matchedDeep.length > 2 ? ` +${matchedDeep.length - 2}` : "";
    reasons.push(`touches high-risk path (${sample}${extra})`);
  }

  if (totalLines > policy.maxRoutineLines || fileCount > policy.maxRoutineFiles) {
    reasons.push(`large diff (+${pr.additions}/-${pr.deletions} across ${fileCount} ${fileCount === 1 ? "file" : "files"})`);
  }

  if (reasons.length > 0) {
    return { tier: "deep", depth: "deep", mode: "observe", reasons, source };
  }

  if (files.length > 0 && files.every((f) => policy.routinePaths.some((pat) => matchGlob(pat, f)))) {
    const sample = files.slice(0, 2).join(", ");
    const extra = files.length > 2 ? ` +${files.length - 2}` : "";
    return {
      tier: "routine",
      depth: "quick",
      mode: "observe",
      reasons: [`routine paths only (${sample}${extra})`],
      source,
    };
  }

  return {
    tier: "routine",
    depth: "standard",
    mode: "observe",
    reasons: [`small diff (+${pr.additions}/-${pr.deletions} across ${fileCount} ${fileCount === 1 ? "file" : "files"})`],
    source,
  };
}

/** Human-readable summary line for PR inbox tables and tooltips. */
export function formatTriageSummary(triage: PrTriage): string {
  const label = triage.tier === "deep" ? "deep review" : "routine skim";
  const reason = triage.reasons.join("; ");
  return reason ? `${label} (observe) — ${reason}` : `${label} (observe)`;
}

/** Parse serialized item triage JSON safely. */
export function parsePrTriage(raw: string | null | undefined): PrTriage | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<PrTriage>;
    if ((v.tier !== "routine" && v.tier !== "deep") || !Array.isArray(v.reasons)) return null;
    return {
      tier: v.tier,
      depth: v.depth === "quick" || v.depth === "standard" || v.depth === "deep" ? v.depth : v.tier === "deep" ? "deep" : "standard",
      mode: "observe",
      reasons: v.reasons.filter((r): r is string => typeof r === "string"),
      source: v.source === "policy" ? "policy" : "default",
    };
  } catch {
    return null;
  }
}
