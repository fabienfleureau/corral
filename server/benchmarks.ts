import type { Db } from './db.ts';

export interface BenchmarkResult {
  id: string; benchmark: string; agent: string; model: string; reasoning: string | null;
  score: number; date: string | null; source: string;
}
const sweUrl = 'https://raw.githubusercontent.com/SWE-bench/swe-bench.github.io/master/data/leaderboards.json';
const terminalDir = 'https://api.github.com/repos/harbor-framework/terminal-bench/contents/leaderboard/submissions';
type Obj = Record<string, any>;

export function parseSwe(data: unknown): BenchmarkResult[] {
  const boards = (data as Obj)?.leaderboards;
  if (!Array.isArray(boards)) throw new Error('Invalid SWE-bench leaderboard');
  return boards.flatMap((board: Obj) => Array.isArray(board.results) ? board.results.flatMap((r: Obj) => {
    if (typeof r.resolved !== 'number' || !Number.isFinite(r.resolved) || typeof r.folder !== 'string') return [];
    return [{ id: `${board.name}/${r.folder}`, benchmark: `SWE-bench ${board.name}`, agent: r.agent || 'Undisclosed', model: r.model_display || r.name || 'Undisclosed', reasoning: r.reasoning_effort || null, score: r.resolved, date: r.date || null, source: `https://github.com/SWE-bench/experiments/tree/main/evaluation/${String(board.name).toLowerCase()}/${encodeURIComponent(r.folder)}` }];
  }) : []);
}

export function parseTerminal(data: unknown, name: string): BenchmarkResult | null {
  const r = data as Obj;
  const m = r?.metadata;
  if (typeof r?.metrics?.accuracy !== 'number' || !Number.isFinite(r.metrics.accuracy) || !m?.agent_display?.label || !m?.model_display?.label) return null;
  return { id: name, benchmark: 'Terminal-Bench 4.0', agent: m.agent_display.label, model: m.model_display.label, reasoning: m.reasoning_effort || null, score: r.metrics.accuracy, date: m.date || null, source: `https://github.com/harbor-framework/terminal-bench/blob/main/leaderboard/submissions/${encodeURIComponent(name)}` };
}

async function getJson(url: string): Promise<any> {
  const response = await fetch(url, { headers: { 'User-Agent': 'corral-benchmarks', Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Benchmark source returned HTTP ${response.status}`);
  return response.json();
}

export async function syncBenchmarks(db: Db): Promise<void> {
  const [sweData, listing] = await Promise.all([getJson(sweUrl), getJson(terminalDir)]);
  if (!Array.isArray(listing)) throw new Error('Invalid Terminal-Bench listing');
  const names = listing.filter((x: Obj) => x.type === 'file' && typeof x.name === 'string' && /^[a-zA-Z0-9_.-]+\.json$/.test(x.name)).map((x: Obj) => x.name as string);
  if (!names.length) throw new Error('Terminal-Bench listing is empty');
  const terminal: BenchmarkResult[] = [];
  for (let i = 0; i < names.length; i += 10) {
    const batch = await Promise.all(names.slice(i, i + 10).map(async (name: string) => parseTerminal(await getJson(`https://raw.githubusercontent.com/harbor-framework/terminal-bench/main/leaderboard/submissions/${encodeURIComponent(name)}`), name)));
    terminal.push(...batch.filter((r): r is BenchmarkResult => r !== null));
  }
  const swe = parseSwe(sweData);
  if (!swe.length || terminal.length !== names.length) throw new Error('Benchmark source is empty or contains invalid results');
  db.raw.prepare('INSERT INTO benchmark_snapshot (id, fetched_ms, results) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET fetched_ms=excluded.fetched_ms, results=excluded.results').run(Date.now(), JSON.stringify([...swe, ...terminal]));
}

export interface ManualBenchmark { model: string; benchmark: string; score: number }

export function saveManualBenchmark(db: Db, value: ManualBenchmark): void {
  if (typeof value?.model !== 'string' || !value.model.trim() || typeof value.benchmark !== 'string' || !value.benchmark.trim() || typeof value.score !== 'number' || !Number.isFinite(value.score) || value.score < 0 || value.score > 100) throw new Error('Model, benchmark and a score between 0 and 100 are required');
  db.raw.prepare('INSERT INTO benchmark_manual (model, benchmark, score) VALUES (?, ?, ?) ON CONFLICT(model, benchmark) DO UPDATE SET score=excluded.score').run(value.model.trim(), value.benchmark.trim(), value.score);
}

export function deleteManualBenchmark(db: Db, model: string, benchmark: string): void {
  db.raw.prepare('DELETE FROM benchmark_manual WHERE model=? AND benchmark=?').run(model, benchmark);
}

export function getBenchmarks(db: Db): { fetched_ms: number | null; results: BenchmarkResult[]; manual: ManualBenchmark[] } {
  const row = db.raw.prepare('SELECT fetched_ms, results FROM benchmark_snapshot WHERE id=1').get() as { fetched_ms: number; results: string } | undefined;
  const manual = db.raw.prepare('SELECT model, benchmark, score FROM benchmark_manual').all() as unknown as ManualBenchmark[];
  return { fetched_ms: row?.fetched_ms ?? null, results: row ? JSON.parse(row.results) : [], manual };
}
