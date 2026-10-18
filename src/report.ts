/**
 * Report generator: turns a run-record JSON (from experiment.ts) into summary
 * statistics (speedup, efficiency, throughput) and a markdown report.
 *
 * Usage: npx tsx src/report.ts data/results/exp-<id>.json [out.md]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { RunRecord } from "./shared/types.js";

interface Agg {
  unitsMb: number;
  maxConcurrency: number;
  runs: number;
  meanMs: number;
  minMs: number;
  maxMs: number;
  rows: number;
  speedup: number;
  efficiency: number;
  throughputRowsps: number;
  verified: boolean;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function analyze(records: RunRecord[]): Agg[] {
  const timed = records.filter((r) => !r.warmup && r.status === "SUCCEEDED");
  const byConfig = new Map<string, RunRecord[]>();
  for (const r of timed) {
    const key = `${r.config.unitsMb}|${r.config.maxConcurrency}`;
    (byConfig.get(key) ?? byConfig.set(key, []).get(key)!).push(r);
  }
  const aggs: Agg[] = [];
  for (const [key, runs] of byConfig) {
    const [unitsMb, maxConcurrency] = key.split("|").map(Number);
    const totals = runs.map((r) => r.totalMs);
    aggs.push({
      unitsMb: unitsMb!,
      maxConcurrency: maxConcurrency!,
      runs: runs.length,
      meanMs: mean(totals),
      minMs: Math.min(...totals),
      maxMs: Math.max(...totals),
      rows: runs[0]!.result?.rows ?? 0,
      speedup: 0,
      efficiency: 0,
      throughputRowsps: 0,
      verified: runs.every((r) => r.result?.verified === true),
    });
  }
  // speedup vs concurrency-1 baseline within the same input size
  for (const agg of aggs) {
    const base = aggs.find((a) => a.unitsMb === agg.unitsMb && a.maxConcurrency === 1);
    agg.speedup = base && base.meanMs > 0 ? base.meanMs / agg.meanMs : 0;
    agg.efficiency = agg.maxConcurrency > 0 ? agg.speedup / agg.maxConcurrency : 0;
    agg.throughputRowsps = agg.meanMs > 0 ? (agg.rows / (agg.meanMs / 1000)) : 0;
  }
  return aggs.sort((a, b) => a.unitsMb - b.unitsMb || a.maxConcurrency - b.maxConcurrency);
}

function toMarkdown(aggs: Agg[]): string {
  const lines: string[] = [];
  lines.push("# Pipeline experiment report");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push(
    "| unitsMb | concurrency | runs | mean(ms) | min(ms) | max(ms) | rows | throughput (rows/s) | speedup | efficiency | verified |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const a of aggs) {
    lines.push(
      `| ${a.unitsMb} | ${a.maxConcurrency} | ${a.runs} | ${Math.round(a.meanMs)} | ${a.minMs} | ${a.maxMs} | ${a.rows.toLocaleString("en-US")} | ${Math.round(a.throughputRowsps).toLocaleString("en-US")} | ${a.speedup.toFixed(2)} | ${a.efficiency.toFixed(2)} | ${a.verified ? "yes" : "NO"} |`,
    );
  }
  lines.push("");
  lines.push(
    "Speedup S(p) = T(1)/T(p); efficiency = S(p)/p, both against the concurrency-1 baseline of the same input size. Warm-up runs excluded.",
  );
  return lines.join("\n");
}

function main(): void {
  const inFile = process.argv[2];
  if (!inFile) throw new Error("usage: report.ts <results.json> [out.md]");
  const records = JSON.parse(readFileSync(inFile, "utf8")) as RunRecord[];
  const aggs = analyze(records);
  const md = toMarkdown(aggs);
  const outFile = process.argv[3] ?? inFile.replace(/\.json$/, ".md");
  writeFileSync(outFile, md);
  console.log(md);
  console.log(`\nreport written to ${outFile}`);
}

main();
