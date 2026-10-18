/**
 * Worker Lambda: processes one record-aligned byte range of a raw CSV object in S3.
 * Streams the range, counts dimensions, writes the partial counts to
 * `<outPrefix>/partials/<unitId>.json`, and returns a compact summary.
 */
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { StringDecoder } from "node:string_decoder";
import { countsFromCounter } from "../core/aggregate.js";
import { LineCounter } from "../core/counter.js";
import { FIELD_COUNT, WorkerEvent, WorkerResult } from "../shared/types.js";

const DIMENSIONS = [3, 5, 11, 19, 20];

export async function handler(event: WorkerEvent): Promise<WorkerResult> {
  const t0 = Date.now();
  const { unitId, key, offset, length, bucket, outPrefix } = event;
  if (!unitId || !key || typeof offset !== "number" || typeof length !== "number") {
    throw new Error(`Invalid worker event: ${JSON.stringify(event).slice(0, 200)}`);
  }
  const bucketName = bucket || process.env.BUCKET_NAME || "";
  const s3 = new S3Client({});

  const rangeEnd = offset + length - 1;
  const res = await s3.send(
    new GetObjectCommand({
      Bucket: bucketName,
      Key: key,
      Range: `bytes=${offset}-${rangeEnd}`,
    }),
  );

  const decoder = new StringDecoder("latin1");
  const counter = new LineCounter(FIELD_COUNT, { extract: DIMENSIONS, singleByte: true });
  const body = res.Body as unknown as AsyncIterable<Uint8Array>;
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    counter.push(decoder.write(buf));
  }
  counter.push(decoder.end());
  counter.flush();

  const counts = countsFromCounter(counter);
  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: `${outPrefix}/partials/${unitId}.json`,
      Body: JSON.stringify(counts),
      ContentType: "application/json",
    }),
  );

  const ms = Date.now() - t0;
  return { unitId, rows: counter.lines, malformed: counter.malformed, ms };
}
