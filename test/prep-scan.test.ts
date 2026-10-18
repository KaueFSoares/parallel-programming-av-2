import { describe, expect, it } from "vitest";
import { ScanUnit, UnitScanner } from "../src/core/prep-scan.js";
import { FIELD_COUNT } from "../src/shared/types.js";

/** Build a valid RFB-style record line (30 fields, quoted, semicolon-joined). */
function line(overrides: Record<number, string | number> = {}): string {
  const all = Array.from({ length: FIELD_COUNT }, () => "");
  for (const [k, v] of Object.entries(overrides)) all[Number(k)] = String(v);
  return all.map((f) => `"${f.replace(/"/g, '""')}"`).join(";") + "\n";
}

/** Synthetic dataset: varying line lengths, some multibyte content. */
function dataset(lineCount = 120): string {
  let text = "";
  for (let i = 0; i < lineCount; i++) {
    text += line({
      0: String(10000000 + i),
      3: i % 2 === 0 ? "1" : "2",
      4: i % 7 === 0 ? "ação" : "empresa " + "x".repeat(i % 17),
      11: String(4712100 + (i % 5)),
      19: ["SP", "BA", "RJ"][i % 3]!,
      20: String(2927 + (i % 11)),
    });
  }
  return text;
}

/** Push `text` in chunks of `chunkChars` and finish. */
function scan(text: string, targetBytes: number, chunkChars = 7): ScanUnit[] {
  const scanner = new UnitScanner(targetBytes, "raw/test");
  for (let i = 0; i < text.length; i += chunkChars) {
    scanner.push(text.slice(i, i + chunkChars));
  }
  return scanner.finish();
}

function maxLineBytes(text: string): number {
  return Math.max(...text.split("\n").map((l) => Buffer.byteLength(l + "\n", "utf8")));
}

describe("UnitScanner coverage", () => {
  const text = dataset();
  const totalBytes = Buffer.byteLength(text, "utf8");
  const totalRows = text.split("\n").length - 1;

  for (const target of [1, 256, 700, 4096, totalBytes * 2]) {
    it(`produces contiguous, record-aligned units covering every byte (target=${target})`, () => {
      const units = scan(text, target);
      expect(units.length).toBeGreaterThan(0);

      // every byte belongs to exactly one unit, in order
      let cursor = 0;
      for (const unit of units) {
        expect(unit.offset).toBe(cursor);
        expect(unit.length).toBeGreaterThan(0);
        cursor += unit.length;
      }
      expect(cursor).toBe(totalBytes);
      expect(units.reduce((acc, u) => acc + u.length, 0)).toBe(totalBytes);

      // every record belongs to exactly one unit
      expect(units.reduce((acc, u) => acc + u.rows, 0)).toBe(totalRows);
      for (const unit of units) expect(unit.rows).toBeGreaterThan(0);

      // every unit starts at a line start (synthetic lines begin with a quote)
      const buffer = Buffer.from(text, "utf8");
      for (const unit of units) {
        expect(buffer[unit.offset], `offset ${unit.offset}`).toBe(0x22); // "
        expect(new TextDecoder().decode(buffer.subarray(unit.offset, unit.offset + 1))).toBe('"');
      }

      // a unit only overshoots by at most one line
      const longest = maxLineBytes(text);
      for (const unit of units) {
        expect(unit.length).toBeLessThanOrEqual(target + longest);
      }
    });
  }

  it("keeps quoted embedded newlines inside a single record", () => {
    const multi = line({ 4: "linha\nquebrada", 11: "4712100" });
    const text = line() + multi + line();
    for (const target of [1, 100]) {
      const units = scan(text, target, 5);
      expect(units.reduce((acc, u) => acc + u.rows, 0)).toBe(3);
      expect(units.reduce((acc, u) => acc + u.length, 0)).toBe(Buffer.byteLength(text, "utf8"));
      const buffer = Buffer.from(text, "utf8");
      for (const unit of units) expect(buffer[unit.offset]).toBe(0x22);
    }
  });
});

describe("UnitScanner chunking property", () => {
  const text = dataset(60);

  it("returns identical units regardless of chunk boundaries", () => {
    for (const target of [1, 37, 256, 1000]) {
      const reference = scan(text, target, text.length);
      for (const chunk of [1, 3, 7, 64, 997]) {
        expect(scan(text, target, chunk), `target=${target} chunk=${chunk}`).toEqual(reference);
      }
    }
  });
});

describe("UnitScanner edges", () => {
  it("produces no units for empty input", () => {
    const scanner = new UnitScanner(100, "raw/empty");
    expect(scanner.finish()).toEqual([]);
  });

  it("produces no units when only empty strings are pushed", () => {
    const scanner = new UnitScanner(100, "raw/empty");
    scanner.push("");
    scanner.push("");
    expect(scanner.finish()).toEqual([]);
  });

  it("keeps a single line longer than the target as one unit", () => {
    const text = line({ 4: "y".repeat(5000) });
    const units = scan(text, 100);
    expect(units).toEqual([{ offset: 0, length: Buffer.byteLength(text, "utf8"), rows: 1 }]);
  });

  it("does not emit a zero-length unit for a trailing newline", () => {
    const text = line() + line();
    const units = scan(text, 1);
    expect(units).toHaveLength(2);
    expect(units.some((u) => u.length === 0)).toBe(false);
  });

  it("handles a final record without a trailing newline", () => {
    const text = line() + line().trimEnd();
    const units = scan(text, 1);
    expect(units.reduce((acc, u) => acc + u.rows, 0)).toBe(2);
    expect(units.reduce((acc, u) => acc + u.length, 0)).toBe(Buffer.byteLength(text, "utf8"));
  });

  it("rejects a non-positive target size", () => {
    expect(() => new UnitScanner(0, "raw/test")).toThrow(/positive/);
    expect(() => new UnitScanner(Number.NaN, "raw/test")).toThrow(/positive/);
  });
});
