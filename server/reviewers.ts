/** Named review commands a code task runs on its diff before opening the PR/MR. */

export type Reviewer = { name: string; command: string };

export function parseReviewers(value: unknown): Reviewer[] {
  if (!Array.isArray(value)) throw new Error("Reviewers must be an array");
  const seen = new Set<string>();
  return value.map((item: unknown) => {
    if (!item || typeof item !== "object") throw new Error("Invalid reviewer");
    const r = item as Record<string, unknown>;
    if (typeof r.name !== "string" || typeof r.command !== "string" || !r.name.trim() || !r.command.trim()) {
      throw new Error("Each reviewer needs a name and command");
    }
    const name = r.name.trim();
    if (seen.has(name)) throw new Error(`Duplicate reviewer name: ${name}`);
    seen.add(name);
    return { name, command: r.command.trim() };
  });
}
