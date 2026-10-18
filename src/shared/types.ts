/**
 * Shared contracts for the CNPJ Estabelecimentos pipeline.
 * These types are the API between preparation, workers, orchestration, and consolidation.
 * Do not change field names without updating the CDK state machine definition and both handlers.
 */

/** Positional layout of the RFB Estabelecimentos file (30 fields, 0-based indexes). */
export const FIELD = {
  CNPJ_BASE: 0,
  CNPJ_ORDEM: 1,
  CNPJ_DV: 2,
  MATRIZ_FILIAL: 3,
  NOME_FANTASIA: 4,
  SIT_CADASTRAL: 5,
  DATA_SIT_CADASTRAL: 6,
  MOTIVO_SIT_CADASTRAL: 7,
  CIDADE_EXTERIOR: 8,
  PAIS: 9,
  INICIO_ATIVIDADE: 10,
  CNAE_PRINCIPAL: 11,
  CNAE_SECUNDARIA: 12,
  TIPO_LOGRADOURO: 13,
  LOGRADOURO: 14,
  NUMERO: 15,
  COMPLEMENTO: 16,
  BAIRRO: 17,
  CEP: 18,
  UF: 19,
  MUNICIPIO: 20,
  DDD1: 21,
  TELEFONE1: 22,
  DDD2: 23,
  TELEFONE2: 24,
  DDD_FAX: 25,
  FAX: 26,
  EMAIL: 27,
  SIT_ESPECIAL: 28,
  DATA_SIT_ESPECIAL: 29,
} as const;

export const FIELD_COUNT = 30;

/** Dimension counts produced by one worker over one partition. */
export interface DimensionCounts {
  /** Total lines read (line = one record). */
  lines: number;
  /** Lines whose quoted field count differs from FIELD_COUNT. */
  malformed: number;
  /** Counts by dimension; keys are raw field values ("" allowed). */
  uf: Record<string, number>;
  mun: Record<string, number>;
  cnae: Record<string, number>;
  sit: Record<string, number>;
  mf: Record<string, number>;
}

export function emptyCounts(): DimensionCounts {
  return { lines: 0, malformed: 0, uf: {}, mun: {}, cnae: {}, sit: {}, mf: {} };
}

/** Merge partial counts into `into` (mutates; consolidation is run-local). */
export function mergeCounts(into: DimensionCounts, from: DimensionCounts): void {
  into.lines += from.lines;
  into.malformed += from.malformed;
  for (const dim of ["uf", "mun", "cnae", "sit", "mf"] as const) {
    for (const [k, v] of Object.entries(from[dim])) {
      into[dim][k] = (into[dim][k] ?? 0) + v;
    }
  }
}

/**
 * One processing unit: a record-aligned byte range into a raw CSV object in S3.
 * `offset`/`length` are byte offsets; `rows` is the exact record count in the range
 * (computed by preparation, used for completeness verification).
 */
export interface UnitItem {
  unitId: string;
  /** S3 key of the raw source file. */
  key: string;
  offset: number;
  length: number;
  rows: number;
}

/** A unit as handed to the worker (unit fields + run-scoped output prefix). */
export interface WorkerEvent extends UnitItem {
  bucket: string;
  /** Prefix under which the worker writes its partial result, e.g. "runs/<runId>". */
  outPrefix: string;
}

/** Compact summary returned by each worker (kept small; full counts go to S3). */
export interface WorkerResult {
  unitId: string;
  rows: number;
  malformed: number;
  ms: number;
}

/** Consolidator input: Map result (summaries) + run context. */
export interface ConsolidateEvent {
  bucket: string;
  outPrefix: string;
  expectedUnits: number;
  /** Total rows expected across all units (from the manifest; completeness check). */
  expectedRows: number;
  partials: WorkerResult[];
}

/** Consolidator output (returned by the state machine). */
export interface ConsolidateResult {
  units: number;
  expectedUnits: number;
  rows: number;
  expectedRows: number;
  rowsMatched: boolean;
  malformed: number;
  verified: boolean;
  ms: number;
}

/** Step Functions execution input for one pipeline run. */
export interface PipelineInput {
  bucket: string;
  /** S3 key of the manifest JSON array (UnitItem[]) used by the Map ItemReader. */
  manifestKey: string;
  maxConcurrency: number;
  /** Number of units in the manifest (completeness check). */
  expectedUnits: number;
  /** Total rows across all manifest units (completeness check). */
  expectedRows: number;
  /** Run-scoped output prefix, e.g. "runs/2026-10-18T22-00-00". */
  outPrefix: string;
}

/** Manifest artifact produced by preparation (raw file registry + base units). */
export interface BaseManifest {
  version: 1;
  /** Byte size of the base partition grid used to compose larger units. */
  baseUnitBytes: number;
  raw: { key: string; size: number }[];
  /** Record-aligned base units, in order, covering every raw file exactly once. */
  units: { key: string; offset: number; length: number; rows: number }[];
}

/** Final result object written to `<outPrefix>/result.json`. */
export interface FinalResult {
  runId: string;
  config: { manifestKey: string; maxConcurrency: number; expectedUnits: number };
  totals: DimensionCounts;
  verification: ConsolidateResult & { invariantHolds: boolean };
  startedAt: string;
  finishedAt: string;
  durationsMs: {
    total: number;
    fanOut: number;
    consolidate: number;
  };
}

/** One measured pipeline run, recorded by the experiment harness. */
export interface RunRecord {
  runId: string;
  config: { unitsMb: number; maxConcurrency: number; manifestKey: string };
  status: string;
  /** Warm-up runs are recorded but excluded from statistics. */
  warmup?: boolean;
  startedAt: string;
  finishedAt: string;
  /** Span from first to last execution-history event (ms). */
  totalMs: number;
  /** MapRunStarted -> MapRunSucceeded span (ms). */
  fanOutMs: number;
  /** Consolidator task scheduled -> succeeded span (ms). */
  consolidateMs: number;
  result: ConsolidateResult | undefined;
  error: string | undefined;
}
