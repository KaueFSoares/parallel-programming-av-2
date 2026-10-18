import { DimensionCounts, emptyCounts, FIELD } from "../shared/types.js";
import { LineCounter } from "./counter.js";

/** Field indexes extracted per dimension (see FIELD in shared/types.ts). */
export const DIMENSION_FIELDS = {
  mf: FIELD.MATRIZ_FILIAL,
  sit: FIELD.SIT_CADASTRAL,
  cnae: FIELD.CNAE_PRINCIPAL,
  uf: FIELD.UF,
  mun: FIELD.MUNICIPIO,
} as const;

/** Convert a finished LineCounter's extracted buckets into DimensionCounts. */
export function countsFromCounter(counter: LineCounter): DimensionCounts {
  const out = emptyCounts();
  out.lines = counter.lines;
  out.malformed = counter.malformed;
  for (const [dim, idx] of Object.entries(DIMENSION_FIELDS)) {
    const buckets = counter.extracted[idx];
    if (buckets) out[dim as keyof typeof DIMENSION_FIELDS] = buckets;
  }
  return out;
}
