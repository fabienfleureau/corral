export type SyncError = { source: string; message: string; updated_ms: number };

export class ErrorCenter {
  private errors = new Map<string, SyncError>();

  fail(source: string, error: unknown): void {
    this.errors.set(source, { source, message: error instanceof Error ? error.message : String(error), updated_ms: Date.now() });
  }

  clear(source: string): void { this.errors.delete(source); }
  list(): SyncError[] { return [...this.errors.values()].sort((a, b) => b.updated_ms - a.updated_ms); }
}

export const errors = new ErrorCenter();
