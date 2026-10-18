import { describe, expect, it } from "vitest";
import { composeUnits } from "../src/core/compose.js";
import { BaseManifest } from "../src/shared/types.js";

function baseManifest(): BaseManifest {
  return {
    version: 1,
    baseUnitBytes: 100,
    raw: [
      { key: "raw/file0", size: 250 },
      { key: "raw/file1", size: 120 },
    ],
    // file0: 3 base units (100, 100, 50) — record aligned in reality; sizes here just need math
    units: [
      { key: "raw/file0", offset: 0, length: 100, rows: 10 },
      { key: "raw/file0", offset: 100, length: 100, rows: 10 },
      { key: "raw/file0", offset: 200, length: 50, rows: 5 },
      { key: "raw/file1", offset: 0, length: 100, rows: 7 },
      { key: "raw/file1", offset: 100, length: 20, rows: 2 },
    ],
  };
}

describe("composeUnits", () => {
  it("groups consecutive base units within the same file", () => {
    const units = composeUnits(baseManifest(), 200);
    expect(units).toEqual([
      { unitId: "00-000000", key: "raw/file0", offset: 0, length: 200, rows: 20 },
      { unitId: "00-000001", key: "raw/file0", offset: 200, length: 50, rows: 5 },
      { unitId: "01-000002", key: "raw/file1", offset: 0, length: 120, rows: 9 },
    ]);
  });

  it("never groups across file boundaries", () => {
    const units = composeUnits(baseManifest(), 300);
    // file0: first unit takes all 3 base units (100+100+50=250 < 300 group would want 3 base units of 100)
    expect(units[0]).toMatchObject({ key: "raw/file0", offset: 0, length: 250, rows: 25 });
    expect(units[1]).toMatchObject({ key: "raw/file1", offset: 0, length: 120, rows: 9 });
    expect(units.length).toBe(2);
  });

  it("covers every byte exactly once (per raw file)", () => {
    const m = baseManifest();
    for (const target of [100, 200, 300]) {
      const units = composeUnits(m, target);
      const byFile = new Map<string, { cursor: number; covered: number }>();
      for (const u of units) {
        const f = byFile.get(u.key) ?? { cursor: 0, covered: 0 };
        expect(u.offset, `target=${target} unit=${u.unitId}`).toBe(f.cursor);
        f.cursor = u.offset + u.length;
        f.covered += u.length;
        byFile.set(u.key, f);
      }
      for (const raw of m.raw) {
        expect(byFile.get(raw.key)?.covered, `target=${target} key=${raw.key}`).toBe(raw.size);
      }
    }
  });

  it("rejects non-multiple target sizes", () => {
    expect(() => composeUnits(baseManifest(), 150)).toThrow(/multiple/);
    expect(() => composeUnits(baseManifest(), 50)).toThrow(/multiple/);
  });
});
