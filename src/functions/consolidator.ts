/**
 * Consolidator Lambda: merges all partial counts for a run, verifies completeness
 * against the manifest totals, and writes the final result to `<outPrefix>/result.json`.
 */
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  ConsolidateEvent,
  ConsolidateResult,
  DimensionCounts,
  emptyCounts,
  FinalResult,
  mergeCounts,
} from "../shared/types.js";

export async function handler(event: ConsolidateEvent): Promise<ConsolidateResult> {
  const t0 = Date.now();
  const { bucket, outPrefix, expectedUnits, expectedRows, partials } = event;
  const bucketName = bucket || process.env.BUCKET_NAME || "";
  const s3 = new S3Client({});

  const totals: DimensionCounts = emptyCounts();
  let rowsFromSummaries = 0;
  let malformedFromSummaries = 0;
  let filesOk = true;

  for (const p of partials) {
    rowsFromSummaries += p.rows;
    malformedFromSummaries += p.malformed;
    const res = await s3.send(
      new GetObjectCommand({ Bucket: bucketName, Key: `${outPrefix}/partials/${p.unitId}.json` }),
    );
    const text = await streamToString(res.Body as unknown as AsyncIterable<Uint8Array>);
    const counts = JSON.parse(text) as DimensionCounts;
    if (counts.lines !== p.rows || counts.malformed !== p.malformed) {
      filesOk = false;
    }
    mergeCounts(totals, counts);
  }

  const units = partials.length;
  const rowsMatched = rowsFromSummaries === expectedRows && totals.lines === expectedRows;
  const verified = units === expectedUnits && rowsMatched && filesOk;
  const invariantHolds = filesOk && totals.lines === rowsFromSummaries;

  const result: FinalResult = {
    runId: outPrefix.split("/").pop() ?? outPrefix,
    config: { manifestKey: "", maxConcurrency: 0, expectedUnits },
    totals,
    verification: {
      units,
      expectedUnits,
      rows: totals.lines,
      expectedRows,
      rowsMatched,
      malformed: totals.malformed,
      verified,
      ms: 0,
      invariantHolds,
    },
    startedAt: new Date(t0).toISOString(),
    finishedAt: new Date().toISOString(),
    durationsMs: { total: 0, fanOut: 0, consolidate: 0 },
  };
  result.verification.ms = Date.now() - t0;

  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: `${outPrefix}/result.json`,
      Body: JSON.stringify(result),
      ContentType: "application/json",
    }),
  );

  return {
    units,
    expectedUnits,
    rows: totals.lines,
    expectedRows,
    rowsMatched,
    malformed: totals.malformed,
    verified,
    ms: Date.now() - t0,
  };
}

async function streamToString(body: AsyncIterable<Uint8Array>): Promise<string> {
  let out = "";
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    out += buf.toString("utf8");
  }
  return out;
}
