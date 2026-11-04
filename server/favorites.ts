export type Favorite = { name: string; harness: string; agent: string; model: string; reasoning: string };

export function parseFavorites(value: unknown): Favorite[] {
  if (!Array.isArray(value)) throw new Error("Favorites must be an array");
  return value.map((item: unknown) => {
    if (!item || typeof item !== "object") throw new Error("Invalid favorite");
    const f = item as Record<string, unknown>;
    if (["name", "harness", "agent", "model", "reasoning"].some((key) => typeof f[key] !== "string") || !(f.name as string).trim() || !(f.harness as string).trim()) throw new Error("Each favorite needs a name and harness");
    return { name: (f.name as string).trim(), harness: (f.harness as string).trim(), agent: f.agent as string, model: f.model as string, reasoning: f.reasoning as string };
  });
}
