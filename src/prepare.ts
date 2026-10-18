/**
 * Preparation CLI: stream the source Estabelecimentos CSVs, split them into
 * record-aligned base units, and write the manifests consumed by Step Functions.
 *
 * Usage (defaults shown):
 *   tsx src/prepare.ts \
 *     --data-dir data/estabelecimentos \
 *     --base-unit-mb 16 \
 *     --out-dir data/manifests \
 *     --compose-mb 64,256,1024 \
 *     [--bucket NAME] [--raw-prefix raw] \
 *     [--endpoint http://localhost:4566] [--region us-east-1] \
 *     [--upload-raw]
 *
 * Files are streamed (never loaded whole). The command prints only structural
 * statistics — never record values.
 */
import { createReadStream } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { composeUnits } from "./core/compose.js";
import { ScanUnit, UnitScanner } from "./core/prep-scan.js";
import { s3ClientOptions } from "./shared/aws-client.js";
import { BaseManifest } from "./shared/types.js";

const MB = 1024 * 1024;
const READ_CHUNK_BYTES = 8 * MB;
const UPLOAD_PART_BYTES = 20 * MB;

interface CliOptions {
  dataDir: string;
  baseUnitMb: number;
  outDir: string;
  composeMb: number[];
  bucket: string | undefined;
  rawPrefix: string;
  endpoint: string;
  region: string;
  uploadRaw: boolean;
}

interface ScannedFile {
  path: string;
  key: string;
  size: number;
}

interface ComposeResult {
  mb: number;
  units: number;
}

function parsePositiveNumber(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${flag} expects a positive number (got "${raw}")`);
  }
  return value;
}

function parseComposeMb(raw: string): number[] {
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    throw new Error(`--compose-mb expects a comma-separated list of sizes in MB (got "${raw}")`);
  }
  return parts.map((part) => parsePositiveNumber(part, "--compose-mb"));
}

function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = {
    dataDir: "data/estabelecimentos",
    baseUnitMb: 16,
    outDir: "data/manifests",
    composeMb: parseComposeMb("64,256,1024"),
    bucket: undefined,
    rawPrefix: "raw",
    endpoint: process.env.AWS_ENDPOINT_URL ?? "",
    region: "us-east-1",
    uploadRaw: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) break;
    if (!token.startsWith("--")) {
      throw new Error(`unexpected argument: ${token}`);
    }
    const eq = token.indexOf("=");
    const name = token.slice(2, eq === -1 ? undefined : eq);
    const takeValue = (): string => {
      if (eq !== -1) return token.slice(eq + 1);
      i += 1;
      const value = argv[i];
      if (value === undefined) throw new Error(`--${name} expects a value`);
      return value;
    };

    switch (name) {
      case "data-dir":
        opts.dataDir = takeValue();
        break;
      case "base-unit-mb":
        opts.baseUnitMb = parsePositiveNumber(takeValue(), "--base-unit-mb");
        break;
      case "out-dir":
        opts.outDir = takeValue();
        break;
      case "compose-mb":
        opts.composeMb = parseComposeMb(takeValue());
        break;
      case "bucket":
        opts.bucket = takeValue();
        break;
      case "raw-prefix":
        opts.rawPrefix = takeValue();
        break;
      case "endpoint":
        opts.endpoint = takeValue();
        break;
      case "region":
        opts.region = takeValue();
        break;
      case "upload-raw":
        if (eq !== -1) throw new Error("--upload-raw is a flag and takes no value");
        opts.uploadRaw = true;
        break;
      default:
        throw new Error(`unknown flag: --${name}`);
    }
  }
  return opts;
}

/** Input files sorted by name; falls back to every regular file when none match. */
async function listInputFiles(dataDir: string): Promise<string[]> {
  const entries = await readdir(dataDir, { withFileTypes: true });
  const regular = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const estabelecimentos = regular.filter((name) => name.endsWith(".ESTABELE"));
  if (estabelecimentos.length > 0) return estabelecimentos.sort(compareNames);
  if (regular.length === 0) throw new Error(`no input files found in ${dataDir}`);
  console.warn(
    `warn: no *.ESTABELE files in ${dataDir}; falling back to all regular files (${regular.length})`,
  );
  return regular.sort(compareNames);
}

function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Stream one file through the scanner without holding it in memory. */
async function scanFile(
  path: string,
  key: string,
  baseUnitBytes: number,
): Promise<{ units: ScanUnit[]; size: number }> {
  const scanner = new UnitScanner(baseUnitBytes, key, { singleByte: true });
  const decoder = new StringDecoder("latin1");
  let size = 0;
  const stream = createReadStream(path, { highWaterMark: READ_CHUNK_BYTES });
  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    scanner.push(decoder.write(buffer));
  }
  const tail = decoder.end();
  if (tail.length > 0) scanner.push(tail);
  const units = scanner.finish();
  const covered = units.reduce((acc, unit) => acc + unit.length, 0);
  if (covered !== size) {
    throw new Error(
      `byte accounting mismatch for ${basename(path)}: read ${size} bytes but units cover ${covered}`,
    );
  }
  return { units, size };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function mbLabel(mb: number): string {
  return String(mb);
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    candidate.$metadata?.httpStatusCode === 404 ||
    candidate.name === "NotFound" ||
    candidate.name === "NoSuchKey"
  );
}

/** True when the object exists with exactly `size` bytes. */
async function objectMatches(
  client: S3Client,
  bucket: string,
  key: string,
  size: number,
): Promise<boolean> {
  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return head.ContentLength === size;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function uploadFile(
  client: S3Client,
  bucket: string,
  key: string,
  path: string,
  partSize?: number,
): Promise<void> {
  const upload = new Upload({
    client,
    params: { Bucket: bucket, Key: key, Body: createReadStream(path) },
    ...(partSize === undefined ? {} : { partSize }),
  });
  await upload.done();
}

async function syncToS3(
  opts: CliOptions,
  scanned: readonly ScannedFile[],
  written: readonly string[],
): Promise<void> {
  const bucket = opts.bucket;
  if (bucket === undefined) return;
  const client = new S3Client(s3ClientOptions({ endpoint: opts.endpoint, region: opts.region }));

  for (const raw of scanned) {
    if (await objectMatches(client, bucket, raw.key, raw.size)) continue;
    if (!opts.uploadRaw) {
      console.warn(
        `warn: s3://${bucket}/${raw.key} is missing or has a different size; skipping upload (--upload-raw not set)`,
      );
      continue;
    }
    console.log(`uploading raw s3://${bucket}/${raw.key} (${raw.size} bytes)`);
    await uploadFile(client, bucket, raw.key, raw.path, UPLOAD_PART_BYTES);
  }

  for (const path of written) {
    const key = `manifests/${basename(path)}`;
    console.log(`uploading manifest s3://${bucket}/${key}`);
    await uploadFile(client, bucket, key, path);
  }
  client.destroy();
}

async function main(): Promise<void> {
  const startedAt = performance.now();
  const opts = parseArgs(process.argv.slice(2));
  const baseUnitBytes = Math.round(opts.baseUnitMb * MB);
  if (baseUnitBytes <= 0) {
    throw new Error(`--base-unit-mb resolves to ${baseUnitBytes} bytes; must be at least 1 byte`);
  }

  const files = await listInputFiles(opts.dataDir);
  const manifest: BaseManifest = {
    version: 1,
    baseUnitBytes,
    raw: [],
    units: [],
  };
  const scanned: ScannedFile[] = [];
  let totalBytes = 0;

  for (const name of files) {
    const path = join(opts.dataDir, name);
    const key = `${opts.rawPrefix}/${name}`;
    const result = await scanFile(path, key, baseUnitBytes);
    scanned.push({ path, key, size: result.size });
    manifest.raw.push({ key, size: result.size });
    for (const unit of result.units) {
      manifest.units.push({
        key,
        offset: unit.offset,
        length: unit.length,
        rows: unit.rows,
      });
    }
    totalBytes += result.size;
  }

  await mkdir(opts.outDir, { recursive: true });
  const written: string[] = [];
  const basePath = join(opts.outDir, `base-${mbLabel(opts.baseUnitMb)}mb.json`);
  await writeJson(basePath, manifest);
  written.push(basePath);

  const composed: ComposeResult[] = [];
  const seenTargets = new Set<number>();
  for (const mb of opts.composeMb) {
    const targetBytes = Math.round(mb * MB);
    if (targetBytes === baseUnitBytes || seenTargets.has(targetBytes)) continue;
    seenTargets.add(targetBytes);
    if (targetBytes % baseUnitBytes !== 0) {
      throw new Error(
        `--compose-mb ${mb} (${targetBytes} bytes) is not a multiple of the base unit size (${baseUnitBytes} bytes)`,
      );
    }
    const units = composeUnits(manifest, targetBytes);
    const path = join(opts.outDir, `units-${mbLabel(mb)}mb.json`);
    await writeJson(path, units);
    written.push(path);
    composed.push({ mb, units: units.length });
  }

  await syncToS3(opts, scanned, written);

  const totalRows = manifest.units.reduce((acc, unit) => acc + unit.rows, 0);
  const elapsed = (performance.now() - startedAt) / 1000;
  console.log(`files: ${files.length}`);
  console.log(`total bytes: ${totalBytes} (${(totalBytes / (1024 * MB)).toFixed(2)} GiB)`);
  console.log(`base unit size: ${baseUnitBytes} bytes (${opts.baseUnitMb} MB)`);
  console.log(`base units: ${manifest.units.length}`);
  console.log(`total rows: ${totalRows}`);
  for (const item of composed) {
    console.log(`units-${mbLabel(item.mb)}mb.json: ${item.units} units`);
  }
  console.log(`out dir: ${opts.outDir}`);
  console.log(
    opts.bucket === undefined ? "s3: skipped (no --bucket)" : `s3: bucket=${opts.bucket}`,
  );
  console.log(`elapsed: ${elapsed.toFixed(2)} s`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`error: ${message}`);
  process.exitCode = 1;
});
