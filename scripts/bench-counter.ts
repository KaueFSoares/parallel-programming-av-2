/**
 * Smoke check + throughput benchmark of LineCounter against real data.
 * Usage: npx tsx scripts/bench-counter.ts <file> [limitMb]
 */
import { createReadStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { LineCounter } from "../src/core/counter.js";
import { FIELD_COUNT } from "../src/shared/types.js";

const file = process.argv[2] ?? "data/samples/example.csv";
const limitBytes = Number(process.argv[3] ?? Infinity) * 1024 * 1024;

const decoder = new StringDecoder("latin1");
const counter = new LineCounter(FIELD_COUNT, { extract: [3, 5, 11, 19, 20], singleByte: true });
let consumed = 0;
const t0 = performance.now();

const stream = createReadStream(file, { highWaterMark: 4 * 1024 * 1024 });
for await (const chunk of stream) {
  const buf = chunk as Buffer;
  consumed += buf.length;
  counter.push(decoder.write(buf));
  if (consumed >= limitBytes) {
    stream.destroy();
    break;
  }
}
counter.push(decoder.end());
counter.flush();
const seconds = (performance.now() - t0) / 1000;
const mb = consumed / 1024 / 1024;

console.log(JSON.stringify({
  file,
  bytes: consumed,
  lines: counter.lines,
  malformed: counter.malformed,
  seconds: Math.round(seconds * 100) / 100,
  throughputMBps: Math.round(mb / seconds),
  throughputRowsps: Math.round(counter.lines / seconds),
  sampleCounts: {
    mf: counter.extracted[3],
    sit: counter.extracted[5],
    uf: counter.extracted[19],
    cnae: counter.extracted[11],
    mun: counter.extracted[20],
  },
}, null, 2));
