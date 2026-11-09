import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { BenchmarkSnapshot } from '../types';
import { errText } from '../util';

export function BenchmarksPage() {
  const [snapshot, setSnapshot] = useState<BenchmarkSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [benchmark, setBenchmark] = useState('Terminal-Bench 4.0');
  useEffect(() => { api.getBenchmarks().then(setSnapshot).catch(e => setError(errText(e))); }, []);
  const benchmarks = useMemo(() => [...new Set((snapshot?.results ?? []).map(r => r.benchmark))].sort(), [snapshot]);
  const results = useMemo(() => (snapshot?.results ?? []).filter(r => r.benchmark === benchmark && `${r.model} ${r.agent} ${r.reasoning ?? ''}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => b.score - a.score), [snapshot, benchmark, query]);
  async function sync() {
    setBusy(true); setError('');
    try { setSnapshot(await api.syncBenchmarks()); } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  }
  return <section>
    <div className="bench-head"><div><h1>Benchmarks</h1><p className="muted">Published results for coding agents, models and reasoning settings.</p></div><button className="btn btn-primary" disabled={busy} onClick={sync}>{busy ? 'Syncing…' : 'Sync results'}</button></div>
    <p className="muted">{snapshot?.fetched_ms ? `Last synced ${new Date(snapshot.fetched_ms).toLocaleString()}` : 'No results synced yet.'} Results stay unchanged until the next sync.</p>
    <p className="muted">Results are measured by their publishers. A missing configuration or reasoning level is not an estimate. Scores from different benchmarks are not directly comparable.</p>
    {error && <p className="inline-error">{error}</p>}
    {snapshot?.results.length ? <><div className="bench-filters"><label>Benchmark <select value={benchmark} onChange={e => setBenchmark(e.target.value)}>{benchmarks.map(b => <option key={b}>{b}</option>)}</select></label><label>Search <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Model, agent or reasoning" /></label></div><div className="bench-table"><table><thead><tr><th>Model</th><th>Agent / harness</th><th>Reasoning</th><th>Score</th><th>Published</th><th>Source</th></tr></thead><tbody>{results.map(r => <tr key={`${r.benchmark}/${r.id}`}><td>{r.model}</td><td>{r.agent}</td><td>{r.reasoning || 'Not reported'}</td><td>{r.score.toFixed(1)}%</td><td>{r.date || '—'}</td><td><a href={r.source} target="_blank" rel="noreferrer">View result</a></td></tr>)}</tbody></table>{!results.length && <p className="muted">No published results match this search.</p>}</div></> : null}
  </section>;
}
