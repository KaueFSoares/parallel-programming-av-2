import { describe, expect, it } from "vitest";
import { countsFromCounter, DIMENSION_FIELDS } from "../src/core/aggregate.js";
import { LineCounter } from "../src/core/counter.js";
import { emptyCounts, mergeCounts, FIELD_COUNT } from "../src/shared/types.js";

function line(overrides: Record<number, string | number> = {}): string {
  const all = Array.from({ length: FIELD_COUNT }, () => "");
  for (const [k, v] of Object.entries(overrides)) all[Number(k)] = String(v);
  return all.map((f) => `"${f.replace(/"/g, '""')}"`).join(";") + "\n";
}

describe("countsFromCounter", () => {
  it("maps extracted buckets onto the five dimensions", () => {
    const c = new LineCounter(FIELD_COUNT, { extract: Object.values(DIMENSION_FIELDS) });
    c.push(line({ 3: "1", 5: "02", 11: "4712100", 19: "BA", 20: "2927" }));
    c.push(line({ 3: "2", 5: "08", 11: "4712100", 19: "SP", 20: "3550" }));
    c.push("bad\n");
    c.flush();
    const counts = countsFromCounter(c);
    expect(counts.lines).toBe(3);
    expect(counts.malformed).toBe(1);
    expect(counts.mf).toEqual({ "1": 1, "2": 1 });
    expect(counts.sit).toEqual({ "02": 1, "08": 1 });
    expect(counts.cnae).toEqual({ "4712100": 2 });
    expect(counts.uf).toEqual({ BA: 1, SP: 1 });
    expect(counts.mun).toEqual({ "2927": 1, "3550": 1 });
  });
});

describe("mergeCounts", () => {
  it("sums counts across partials", () => {
    const into = emptyCounts();
    into.lines = 2;
    into.uf = { BA: 2 };
    mergeCounts(into, { lines: 3, malformed: 1, uf: { BA: 1, SP: 2 }, mun: { "2927": 3 }, cnae: { "1": 3 }, sit: { "02": 3 }, mf: { "1": 3 } });
    expect(into.lines).toBe(5);
    expect(into.malformed).toBe(1);
    expect(into.uf).toEqual({ BA: 3, SP: 2 });
    expect(into.mun).toEqual({ "2927": 3 });
  });
});
