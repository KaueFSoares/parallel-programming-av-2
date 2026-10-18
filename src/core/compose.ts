import { BaseManifest, UnitItem } from "../shared/types.js";

/**
 * Compose processing units by grouping consecutive base units of the same raw file.
 * `targetBytes` must be a positive multiple of `baseUnitBytes`. Units are record-aligned
 * by construction (base units are record-aligned and never split), so offsets/lengths
 * stay valid byte ranges for S3 GetObject with Range.
 */
export function composeUnits(manifest: BaseManifest, targetBytes: number): UnitItem[] {
  const { baseUnitBytes, units } = manifest;
  if (targetBytes % baseUnitBytes !== 0 || targetBytes < baseUnitBytes) {
    throw new Error(
      `targetBytes (${targetBytes}) must be a positive multiple of baseUnitBytes (${baseUnitBytes})`,
    );
  }
  const groupSize = targetBytes / baseUnitBytes;
  const out: UnitItem[] = [];
  let fileIndex = 0;
  let i = 0;
  while (i < units.length) {
    const first = units[i]!;
    // group only within the same raw file
    let count = 1;
    while (
      count < groupSize &&
      i + count < units.length &&
      units[i + count]!.key === first.key
    ) {
      count++;
    }
    const last = units[i + count - 1]!;
    out.push({
      unitId: `${String(fileIndex).padStart(2, "0")}-${String(out.length).padStart(6, "0")}`,
      key: first.key,
      offset: first.offset,
      length: last.offset + last.length - first.offset,
      rows: units.slice(i, i + count).reduce((acc, u) => acc + u.rows, 0),
    });
    i += count;
    if (i < units.length && units[i]!.key !== first.key) fileIndex++;
  }
  return out;
}
