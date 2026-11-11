import type { BenchmarkResult } from './benchmarks.ts';

// Vendor-reported scores copied from model release tables. Kept in code, not in
// the synced snapshot, so a sync does not drop them. Left out: ratings and Elo
// scores (the page shows percentages), lower-is-better metrics (the page ranks
// higher first) and vendor-internal benchmarks.
// Benchmark names are aligned across sources when they are the same test, so
// scores land in the same column.
type Score = number | null;
interface ReportedTable {
  key: string; agent: string; source: string; reasoning: string | null;
  models: string[];
  /** One row per benchmark, scores in `models` order; null = not reported. */
  rows: [string, Score[]][];
}

const tables: ReportedTable[] = [{
  key: 'deepseek-v4.1',
  agent: 'DeepSeek (reported)',
  source: 'https://huggingface.co/deepseek-ai',
  reasoning: null,
  models: ['DeepSeek V4.1 Flash', 'DeepSeek V4 Pro (0813)', 'DeepSeek V4 Flash (0731)', 'GLM-5.3', 'Kimi K3', 'GPT-5.6 Sol', 'Claude Opus 5'],
  rows: [
    ['GPQA Diamond', [90.9, 92.4, 89.9, 88.1, 92.9, 94.1, 93.4]],
    ['HLE', [36.8, null, null, null, 43.5, 44.5, 56.3]],
    ['HLE (text-only)', [39.1, 42.7, 37.8, 42.0, null, null, null]],
    ['MathArena Apex', [65.6, 65.3, 58.6, null, 65.6, null, null]],
    ['Terminal-Bench 2.1', [90.6, 87.9, 82.7, 88.2, 88.3, 88.8, 89.1]],
    ['Terminal-Bench 3.0', [30.0, 11.8, 7.6, 28.3, 17.7, 34.4, 43.3]],
    ['Terminal-Bench 4.0', [31.2, 12.4, 7.0, 37.9, 12.6, 39.9, 51.8]],
    ['DeepSWE v1.1', [74.2, 62.7, 54.4, 66.9, 67.5, 73.0, 74.0]],
    ['ProgramBench', [20.3, 15.5, null, 19.0, 17.5, 23.0, 37.0]],
    ['NL2Repo-Bench', [65.4, 61.5, 54.2, 58.0, 58.0, 56.8, 75.3]],
    ['CyberGym', [88.1, 83.3, 76.7, 84.5, 80.0, 84.5, null]],
    ['SEC-Bench Pro', [62.8, 56.4, 30.9, null, null, 74.3, null]],
    ['ExploitGym', [15.3, 5.4, 1.8, 15.0, null, 33.7, 22.1]],
    ['HLE (w/tools)', [63.9, 60.0, 51.5, 62.5, 59.8, null, 63.6]],
    ['Automation-Bench', [54.8, 43.2, 37.7, 48.8, 46.7, 45.8, 50.3]],
    ["Agents' Last Exam", [31.8, 25.7, 25.2, 28.5, 27.6, 26.7, 28.6]],
    ['Chartography (w/tools)', [78.9, null, null, null, 68.1, 79.9, 84.0]],
    ['BabyVision (w/tools)', [89.6, null, null, null, 85.7, 88.9, 94.1]],
    ['ZeroBench-main (w/tools)', [49.0, null, null, null, 41.0, 53.0, 52.0]],
  ],
}, {
  key: 'kimi-k3.1-pro',
  agent: 'Moonshot (reported)',
  source: 'https://huggingface.co/moonshotai/Kimi-K3.1-Pro',
  reasoning: 'max',
  models: ['Kimi K3.1 Pro', 'Claude Fable 5.1', 'GPT-6 Astra', 'Claude Opus 5.5', 'DeepSeek V4.1 Flash (1017)', 'GLM-5.3'],
  rows: [
    ['Terminal-Bench 4.0', [65.7, 57.9, 58.2, 66.4, 42.3, 41.8]],
    ['Terminal-Bench-Science 0.1', [38.1, 40.0, 68.1, 63.3, 15.7, 8.1]],
    ['SWE Marathon v1.1', [51.7, 45.6, 42.5, 46.3, 40.0, 42.5]],
    ['BenchCAD', [72.8, 60.6, null, 73.0, 41.2, null]],
    ['BenchCAD (w/tools)', [92.7, 92.6, 95.9, 96.2, 81.6, null]],
    ['ProgramBench', [31.5, 53.5, 50.0, 65.0, 29.1, 19.0]],
    ['DeepSWE v1.1', [75.5, 67.4, 74.1, 74.2, 77.0, 66.9]],
    ['PostTrain Bench v1.2', [36.5, 44.6, 41.9, 43.8, 30.5, 34.5]],
    ['HLE (w/tools)', [70.0, 65.6, 57.2, 67.7, 58.8, 62.5]],
    ['BrowseComp', [92.1, null, 91.5, 90.8, null, null]],
    ['BioMysteryBench', [80.6, 81.6, 78.9, 81.9, 80.0, 79.6]],
    ['CharXiv RQ (w/tools)', [93.4, 92.7, 92.8, 93.8, 85.6, null]],
    ['MMMU-Pro (w/tools)', [90.0, 88.4, 87.8, 89.8, 82.5, null]],
    ['GDP.pdf (w/tools)', [85.7, 83.8, 85.5, 83.9, 73.0, null]],
    ['Chartography (w/tools)', [90.2, 88.4, 91.0, 89.0, 83.0, null]],
    ['BabyVision (w/tools)', [95.4, 95.1, 96.6, 97.7, 92.5, null]],
    ['ZeroBench-main (w/tools)', [63.0, 59.0, 58.0, 61.0, 51.0, null]],
    ["Agents' Last Exam", [43.2, null, 41.8, 42.6, 37.7, 26.2]],
    ["Agents' Last Exam (CLI)", [44.2, null, 44.2, 40.7, 36.0, 29.4]],
    ['Automation Bench-AA', [73.3, 59.4, 68.5, 69.5, 66.6, 62.2]],
    ['APEX-Agents', [69.4, 68.6, 64.7, 73.5, 69.8, 56.6]],
    ['OfficeQA Pro v2', [64.4, 54.5, 54.4, 62.2, 40.4, 31.1]],
    ['OfficeQA Pro', [67.4, 68.6, 66.2, null, 62.4, 58.6]],
    ['Frontier Finance', [58.6, 60.8, 45.0, 56.7, 54.5, 57.5]],
    ['Harvey Legal Agent', [23.7, 19.1, null, null, 21.0, null]],
    ['HANDBOOK.md', [44.6, 38.8, null, 41.5, 28.9, 20.8]],
    ['OSWorld V2.1', [79.6, 80.7, 75.8, 81.8, 69.3, null]],
    ['GDP.pdf', [34.6, 27.6, 34.2, 30.6, 17.2, 11.2]],
    ['HLE', [51.1, 57.6, 53.6, 59.8, 42.6, null]],
    ['HLE (text-only)', [null, null, null, null, null, 43.0]],
    ['HLE-Diamond', [39.4, 55.1, 65.8, 60.9, 21.6, null]],
    ['HLE-Diamond (text-only)', [null, null, null, null, null, 25.1]],
    ['GPQA Diamond', [94.2, 93.7, 96.1, 93.9, 92.2, 91.7]],
    ['CharXiv RQ', [89.0, 88.8, 90.0, 92.1, 77.0, null]],
    ['MMMU-Pro', [84.1, 86.3, 86.9, 87.7, 80.6, null]],
    ['ZeroBench-main (avg@5)', [29.8, 23.0, 43.2, 35.0, 11.8, null]],
    ['PerceptionBench', [68.3, 63.0, 77.6, 72.1, 47.7, null]],
    ['ExploitBench', [74.7, 83.0, 100, 91.0, null, 54.4]],
    ['ExploitGym', [20.7, 30.4, 42.4, 34.5, null, 15.0]],
  ],
}];

export const reportedResults: BenchmarkResult[] = tables.flatMap((t) => t.rows.flatMap(([benchmark, scores]) => scores.flatMap((score, i) =>
  score === null ? [] : [{ id: `reported/${t.key}/${benchmark}/${t.models[i]}`, benchmark, agent: t.agent, model: t.models[i], reasoning: t.reasoning, score, date: null, source: t.source }])));
