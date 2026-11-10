import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { BenchmarkSnapshot } from '../types';
import { benchmarkColumns, buildBenchmarkRows, type HarnessModelInput } from '../model-match';
import { errText } from '../util';

/** One chip per harness, with the exact model ids behind it in the tooltip. */
function harnessChips(models: HarnessModelInput[]) {
  const byHarness = new Map<string, string[]>();
  for (const model of models) byHarness.set(model.harness, [...(byHarness.get(model.harness) ?? []), model.id]);
  return [...byHarness.entries()].map(([harness, ids]) =>
    <span key={harness} className="bench-harness" title={ids.join('\n')}>{harness}</span>);
}

export function BenchmarksPage() {
  const [snapshot, setSnapshot] = useState<BenchmarkSnapshot | null>(null);
  const [harnessModels, setHarnessModels] = useState<HarnessModelInput[] | null>(null);
  const [catalogError, setCatalogError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [onlyMine, setOnlyMine] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api.getBenchmarks()
      .then((data) => { if (!cancelled) setSnapshot(data); })
      .catch((err: unknown) => { if (!cancelled) setError(errText(err)); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.listHarnesses()
      .then((res) => {
        if (cancelled) return;
        setHarnessModels(res.harnesses.flatMap((h) => (h.models ?? []).map((m) => ({ harness: h.harness, id: m.id, label: m.label }))));
      })
      .catch((err: unknown) => { if (!cancelled) setCatalogError(errText(err)); });
    return () => { cancelled = true; };
  }, []);

  const rows = useMemo(() => buildBenchmarkRows(harnessModels ?? [], snapshot?.results ?? []), [harnessModels, snapshot]);
  const mine = useMemo(() => rows.filter((row) => row.availability.length > 0), [rows]);
  // Without a harness catalog (offline backend, fixture) every published model stays visible.
  const catalogReady = harnessModels !== null && mine.length > 0;
  const restrict = onlyMine && catalogReady;
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (restrict ? mine : rows).filter((row) => !needle
      || row.label.toLowerCase().includes(needle)
      || row.availability.some((model) => `${model.harness} ${model.id} ${model.label}`.toLowerCase().includes(needle))
      || Object.values(row.picks).some((pick) => `${pick.result.model} ${pick.result.agent}`.toLowerCase().includes(needle)));
  }, [rows, mine, restrict, query]);
  // Columns follow the current scope, not the text search: typing must not
  // reshuffle the matrix under the cursor.
  const columns = useMemo(() => benchmarkColumns(restrict ? mine : rows), [rows, mine, restrict]);

  async function sync() {
    setBusy(true); setError('');
    try { setSnapshot(await api.syncBenchmarks()); } catch (err) { setError(errText(err)); } finally { setBusy(false); }
  }

  const catalogNote = catalogError
    ? `Harness models are unavailable (${catalogError}). Showing every published model.`
    : harnessModels === null
      ? 'Loading models from your harnesses…'
      : catalogReady
        ? `${mine.length} of your harness models · ${snapshot?.results.length ?? 0} published results`
        : 'No harness models were reported. Showing every published model.';

  return <section>
    <div className="bench-head"><div><h1>Benchmarks</h1><p className="muted">Published results for coding agents, models and reasoning settings.</p></div><button className="btn btn-primary" disabled={busy} onClick={sync}>{busy ? 'Syncing…' : 'Sync results'}</button></div>
    <p className="muted">{snapshot?.fetched_ms ? `Last synced ${new Date(snapshot.fetched_ms).toLocaleString()}` : 'No results synced yet.'} Results stay unchanged until the next sync.</p>
    <p className="muted">Results are measured by their publishers. A missing configuration or reasoning level is not an estimate. Scores from different benchmarks are not directly comparable.</p>
    <p className="muted">{catalogNote} One column per benchmark; each cell is the best published result for that model and opens its source.</p>
    <p className="muted">Rows come from your harness catalogs. Published names are matched by family, variant and version; a version-less alias (<code>Sonnet</code>) follows the newest published version of that model.</p>
    {error && <p className="inline-error">{error}</p>}
    {snapshot?.results.length ? <>
      <div className="bench-filters"><label>Search <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Model, harness or agent" /></label>{catalogReady ? <label className="bench-toggle"><input type="checkbox" checked={onlyMine} onChange={e => setOnlyMine(e.target.checked)} />Only models in my harnesses</label> : null}</div>
      <div className="bench-table"><table>
        <thead><tr><th className="bench-model-col">Model</th><th>Harnesses</th>{columns.map(name => <th key={name}>{name}</th>)}</tr></thead>
        <tbody>{visible.map(row => <tr key={row.key} className={row.availability.length ? undefined : 'bench-external'}>
          <td className="bench-model-col"><span className="bench-model">{row.label}</span></td>
          <td>{row.availability.length ? harnessChips(row.availability) : <span className="muted">Not in your harnesses</span>}</td>
          {columns.map(name => {
            const pick = row.picks[name];
            if (!pick) return <td key={name}><span className="muted">—</span></td>;
            const detail = `${pick.result.model} · ${pick.result.agent}${pick.result.reasoning ? ` · ${pick.result.reasoning}` : ''}${pick.result.date ? ` · ${pick.result.date}` : ''}`;
            return <td key={name}><a className="bench-score" href={pick.result.source} target="_blank" rel="noreferrer" title={`${detail}${pick.alternatives ? ` · best of ${pick.alternatives + 1} published results` : ''}`}>
              <strong>{pick.result.score.toFixed(1)}%</strong>
              <span className="bench-sub">{pick.result.agent}{pick.result.reasoning ? ` · ${pick.result.reasoning}` : ''}</span>
            </a></td>;
          })}
        </tr>)}</tbody>
      </table>{!visible.length && <p className="muted">{restrict ? 'No published result matches one of your harness models and this search. Untick “Only models in my harnesses” to browse every published model.' : 'No published results match this search.'}</p>}</div>
    </> : null}
  </section>;
}
