/** Length of the short task reference shown in the UI. */
const TASK_REF_CHARS = 8;

/** Short reference for a task UUID. The full UUID stays the canonical id. */
export function taskRef(id: string): string {
  return id.slice(0, TASK_REF_CHARS);
}
