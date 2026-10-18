/**
 * Experiment harness: runs the pipeline state machine under controlled
 * concurrency × input-size configurations, collecting timings from execution
 * history, and records everything to a JSON file for `report.ts`.
 *
 * Usage:
 *   npx tsx src/experiment.ts \
 *     --manifest data/manifests/units-64mb.json \
 *     --concurrency 1,2,4,8,16 \
 *     --reps 3 --warmup 1 \
 *     [--bucket cnpj-pipeline-000000000000] [--state-machine cnpj-pipeline] \
 *     [--endpoint http://localhost:4566] [--region us-east-1] \
 *     [--out data/results/exp.json]
 */
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  DescribeExecutionCommand,
  GetExecutionHistoryCommand,
  SFNClient,
  StartExecutionCommand,
} from "@aws-sdk/client-sfn";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  ConsolidateResult,
  PipelineInput,
  RunRecord,
  UnitItem,
} from "./shared/types.js";

interface Args {
  manifest: string;
  concurrency: number[];
  reps: number;
  warmup: number;
  bucket: string;
  stateMachine: string;
  endpoint: string;
  region: string;
  out: string;
  timeoutMs: number;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string, dflt?: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : dflt;
  };
  const manifest = get("--manifest");
  if (!manifest) throw new Error("--manifest is required (path to a units-<n>mb.json manifest)");
  return {
    manifest,
    concurrency: (get("--concurrency", "1,2,4,8") ?? "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0),
    reps: Number(get("--reps", "3")),
    warmup: Number(get("--warmup", "1")),
    bucket: get("--bucket", "cnpj-pipeline-000000000000") ?? "",
    stateMachine: get("--state-machine", "cnpj-pipeline") ?? "",
    endpoint: get("--endpoint", "http://localhost:4566") ?? "",
    region: get("--region", "us-east-1") ?? "",
    out: get("--out", join("data", "results", `exp-${Date.now()}.json`)) ?? "",
    timeoutMs: Number(get("--timeout-ms", String(30 * 60 * 1000))),
  };
}

function unitsMbFromFilename(path: string): number {
  const m = /units-([\d.]+)mb\.json$/i.exec(basename(path));
  if (!m) throw new Error(`manifest filename must look like units-<n>mb.json: ${path}`);
  return Number(m[1]);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runPipeline(
  sfn: SFNClient,
  stateMachineArn: string,
  input: PipelineInput,
  timeoutMs: number,
): Promise<{ record: Omit<RunRecord, "runId" | "config">; output: ConsolidateResult | undefined }> {
  const started = await sfn.send(new StartExecutionCommand({ stateMachineArn, input: JSON.stringify(input) }));
  const tStart = Date.now();
  let status = "RUNNING";
  let output: string | undefined;
  let error: string | undefined;
  while (Date.now() - tStart < timeoutMs) {
    await sleep(200);
    const d = await sfn.send(new DescribeExecutionCommand({ executionArn: started.executionArn }));
    status = d.status ?? "RUNNING";
    output = d.output;
    if (status !== "RUNNING") break;
  }
  if (status === "RUNNING") status = "TIMEOUT_LOCAL";

  const history = await sfn.send(new GetExecutionHistoryCommand({ executionArn: started.executionArn }));
  const events = history.events ?? [];
  const ts = (type: string): number | undefined => {
    const e = events.find((ev) => ev.type === type);
    return e?.timestamp?.getTime();
  };
  const first = events[0]?.timestamp?.getTime() ?? tStart;
  const last = events[events.length - 1]?.timestamp?.getTime() ?? Date.now();
  const mapStart = ts("MapRunStarted");
  const mapEnd = ts("MapRunSucceeded");
  // consolidator is a direct Lambda ARN task: LambdaFunction* events (Distributed
  // Map children publish into their own executions, so the parent's only
  // LambdaFunction* events belong to the consolidator).
  const consScheduled = events.filter((e) => e.type === "LambdaFunctionScheduled").pop()?.timestamp?.getTime();
  const consSucceeded = events.filter((e) => e.type === "LambdaFunctionSucceeded").pop()?.timestamp?.getTime();

  let result: ConsolidateResult | undefined;
  if (output) {
    try {
      result = JSON.parse(output) as ConsolidateResult;
    } catch {
      /* non-JSON output: leave undefined */
    }
  }
  return {
    output: result,
    record: {
      status,
      startedAt: new Date(first).toISOString(),
      finishedAt: new Date(last).toISOString(),
      totalMs: last - first,
      fanOutMs: mapStart !== undefined && mapEnd !== undefined ? mapEnd - mapStart : -1,
      consolidateMs:
        consScheduled !== undefined && consSucceeded !== undefined ? consSucceeded - consScheduled : -1,
      result,
      error,
    },
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const manifest: UnitItem[] = JSON.parse(readFileSync(args.manifest, "utf8"));
  const manifestKey = `manifests/${basename(args.manifest)}`;
  const expectedUnits = manifest.length;
  const expectedRows = manifest.reduce((acc, u) => acc + u.rows, 0);
  const config = { unitsMb: unitsMbFromFilename(args.manifest), manifestKey };

  const creds = { accessKeyId: "test", secretAccessKey: "test" };
  const s3 = new S3Client({ endpoint: args.endpoint, region: args.region, credentials: creds, forcePathStyle: true });
  const sfn = new SFNClient({ endpoint: args.endpoint, region: args.region, credentials: creds });
  const stateMachineArn = `arn:aws:states:${args.region}:000000000000:stateMachine:${args.stateMachine}`;

  // make sure the manifest is in S3 (ItemReader reads it from there)
  await s3.send(
    new PutObjectCommand({ Bucket: args.bucket, Key: manifestKey, Body: JSON.stringify(manifest) }),
  );

  console.log(
    `manifest=${manifestKey} units=${expectedUnits} rows=${expectedRows.toLocaleString("en-US")} unitsMb=${config.unitsMb}`,
  );
  console.log(`stateMachine=${args.stateMachine} reps=${args.reps} warmup=${args.warmup} concurrency=[${args.concurrency.join(", ")}]`);

  const records: RunRecord[] = [];
  for (const maxConcurrency of args.concurrency) {
    const base: PipelineInput = {
      bucket: args.bucket,
      manifestKey,
      maxConcurrency,
      expectedUnits,
      expectedRows,
      outPrefix: "",
    };
    for (let i = 0; i < args.warmup; i++) {
      const runId = `warm-${config.unitsMb}mb-c${maxConcurrency}-${i}-${Date.now()}`;
      const { record, output } = await runPipeline(sfn, stateMachineArn, { ...base, outPrefix: `runs/${runId}` }, args.timeoutMs);
      records.push({
        runId,
        config: { ...config, maxConcurrency },
        ...record,
        warmup: true,
      });
      console.log(
        `warmup c=${maxConcurrency} status=${record.status} total=${record.totalMs}ms fanOut=${record.fanOutMs}ms verify=${output?.verified ?? "-"}`,
      );
    }
    for (let i = 0; i < args.reps; i++) {
      const runId = `run-${config.unitsMb}mb-c${maxConcurrency}-${i}-${Date.now()}`;
      const { record, output } = await runPipeline(sfn, stateMachineArn, { ...base, outPrefix: `runs/${runId}` }, args.timeoutMs);
      records.push({ runId, config: { ...config, maxConcurrency }, ...record });
      console.log(
        `run    c=${maxConcurrency} status=${record.status} total=${record.totalMs}ms fanOut=${record.fanOutMs}ms cons=${record.consolidateMs}ms verify=${output?.verified ?? "-"} rows=${output?.rows.toLocaleString("en-US") ?? "-"}`,
      );
      if (output && (!output.verified || !output.rowsMatched)) {
        console.error(`WARNING: verification failed for ${runId}:`, JSON.stringify(output));
      }
    }
  }

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(records, null, 2));
  console.log(`results written to ${args.out}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
