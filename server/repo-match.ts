// Which registered repo a PR/MR URL belongs to. Used by the review form so a
// pasted link selects its repo instead of the first one in the registry.
// Pure matching: the caller supplies each repo's local git remote URLs.

import { basename } from "node:path";
import { PR_URL_RE } from "./types.ts";

export interface RepoCandidate {
  path: string;
  name: string;
  remotes: string[];
}

export interface RepoMatch {
  path: string;
  name: string;
  /** `remote` when a git remote points at the PR's project, else repo name. */
  via: "remote" | "name";
}

interface Project {
  host: string;
  path: string;
  name: string;
}

/** The project part of a GitHub/GitLab PR URL, or null for anything else. */
export function pullProject(url: string): Project | null {
  const value = url.trim();
  if (!PR_URL_RE.test(value)) return null;
  let parsed: URL;
  try { parsed = new URL(value); } catch { return null; }
  const segments = parsed.pathname.split("/").filter((part) => part && part !== "-");
  const marker = segments.findIndex((part) => part === "pull" || part === "merge_requests");
  if (marker < 1) return null;
  const parts = segments.slice(0, marker).map((part) => part.replace(/\.git$/i, ""));
  if (parts.some((part) => !part)) return null;
  return { host: parsed.hostname.toLowerCase(), path: parts.join("/").toLowerCase(), name: parts[parts.length - 1].toLowerCase() };
}

/** Host and project path from a git remote, HTTPS or scp syntax. */
function remoteProject(remote: string): Project | null {
  const match = remote.trim().match(/^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?([^/:]+)(?::|\/)(.+)$/i);
  if (!match) return null;
  const parts = match[2].replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return {
    host: match[1].toLowerCase(),
    path: parts.join("/").toLowerCase(),
    name: parts[parts.length - 1].toLowerCase(),
  };
}

function cleanName(value: string): string {
  return basename(value.trim()).replace(/\.git$/i, "").toLowerCase();
}

export function matchRepoForPull(url: string, repos: RepoCandidate[]): RepoMatch | null {
  const target = pullProject(url);
  if (!target) return null;

  // A remote is authoritative: local folder names can differ from the project.
  const remoteMatches = repos.filter((repo) => repo.remotes.some((remote) => {
    const project = remoteProject(remote);
    return project?.host === target.host && project.path === target.path;
  }));
  if (remoteMatches.length === 1) return { path: remoteMatches[0].path, name: remoteMatches[0].name, via: "remote" };
  if (remoteMatches.length > 1) return null; // two remotes for one project: don't guess

  // Without a remote match, fall back to a unique name match. Nested GitLab
  // groups and GitHub owners are ignored here: only the project is compared.
  const nameMatches = repos.filter((repo) =>
    cleanName(repo.name) === target.name || cleanName(repo.path) === target.name);
  if (nameMatches.length === 1) return { path: nameMatches[0].path, name: nameMatches[0].name, via: "name" };
  return null;
}
