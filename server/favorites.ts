export type Context = "professional" | "personal";
export type Favorite = { name: string; harness: string; agent: string; model: string; reasoning: string; context: Context; review: string };

export const CONTEXTS: readonly Context[] = ["professional", "personal"];

export function isContext(value: unknown): value is Context {
  return CONTEXTS.includes(value as Context);
}

export function parseFavorites(value: unknown): Favorite[] {
  if (!Array.isArray(value)) throw new Error("Favorites must be an array");
  return value.map((item: unknown) => {
    if (!item || typeof item !== "object") throw new Error("Invalid favorite");
    const f = item as Record<string, unknown>;
    if (["name", "harness", "agent", "model", "reasoning"].some((key) => typeof f[key] !== "string") || !(f.name as string).trim() || !(f.harness as string).trim()) throw new Error("Each favorite needs a name and harness");
    // Favorites saved before contexts existed are professional.
    const context = f.context === undefined ? "professional" : f.context;
    if (!isContext(context)) throw new Error("Favorite context must be professional or personal");
    // Favorites saved before reviewers existed pick none.
    const review = typeof f.review === "string" ? f.review.trim() : "";
    return { name: (f.name as string).trim(), harness: (f.harness as string).trim(), agent: f.agent as string, model: f.model as string, reasoning: f.reasoning as string, context, review };
  });
}
