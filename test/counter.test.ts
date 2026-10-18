import { describe, expect, it } from "vitest";
import { LineCounter } from "../src/core/counter.js";
import { FIELD_COUNT } from "../src/shared/types.js";

/** Build a valid RFB-style record line (30 fields, quoted, semicolon-joined). */
function line(overrides: Record<number, string | number> = {}): string {
  const all = Array.from({ length: FIELD_COUNT }, () => "");
  for (const [k, v] of Object.entries(overrides)) all[Number(k)] = String(v);
  return all.map((f) => `"${f.replace(/"/g, '""')}"`).join(";") + "\n";
}

function countAll(text: string, opts?: ConstructorParameters<typeof LineCounter>[1]) {
  const c = new LineCounter(FIELD_COUNT, opts);
  // push in awkward chunk sizes to exercise cross-chunk state
  for (let i = 0; i < text.length; i += 7) c.push(text.slice(i, i + 7));
  c.flush();
  return c;
}

describe("LineCounter basics", () => {
  it("counts valid records", () => {
    const c = countAll(
      line({ 0: 123, 3: "1", 5: "08", 11: "4712100", 19: "BA", 20: "2927" }) +
        line() +
        line(),
    );
    expect(c.lines).toBe(3);
    expect(c.malformed).toBe(0);
  });

  it("treats missing trailing newline as a final record", () => {
    const c = countAll(line().trimEnd());
    expect(c.lines).toBe(1);
    expect(c.malformed).toBe(0);
  });

  it("counts empty input as zero records", () => {
    const c = countAll("");
    expect(c.lines).toBe(0);
    expect(c.malformed).toBe(0);
  });

  it("flags wrong field counts as malformed", () => {
    const tooFew = Array.from({ length: 29 }, () => '""').join(";") + "\n";
    const tooMany = Array.from({ length: 31 }, () => '""').join(";") + "\n";
    const c = countAll(line() + tooFew + tooMany + line());
    expect(c.lines).toBe(4);
    expect(c.malformed).toBe(2);
  });

  it("counts a blank line as one malformed record", () => {
    const c = countAll("\n");
    expect(c.lines).toBe(1);
    expect(c.malformed).toBe(1);
  });

  it("does not create a phantom record from a trailing newline", () => {
    const c = countAll("a\n"); // "a" is a single-field record
    expect(c.lines).toBe(1);
    expect(c.malformed).toBe(1);
  });
});

describe("LineCounter quoting", () => {
  it("keeps semicolons inside quoted fields as content", () => {
    const text = line({ 4: "nome; com ; ponto", 11: "4712100" });
    const c = countAll(text, { extract: [4] });
    expect(c.lines).toBe(1);
    expect(c.malformed).toBe(0);
    expect(c.extracted[4]).toEqual({ "nome; com ; ponto": 1 });
  });

  it("handles doubled quotes as escaped quotes", () => {
    const text = line({ 4: 'diz "oi"', 11: "4712100" });
    const c = countAll(text, { extract: [4] });
    expect(c.malformed).toBe(0);
    expect(c.extracted[4]).toEqual({ 'diz "oi"': 1 });
  });

  it("treats newlines inside quoted fields as content, not record boundaries", () => {
    const multi = `"1";"2";"3";"4";"linha
quebrada";"08";"4712100";${Array.from({ length: 23 }, () => '""').join(";")}\n`;
    const c = countAll(multi + line(), { extract: [4] });
    expect(c.lines).toBe(2);
    expect(c.malformed).toBe(0);
    expect(c.extracted[4]?.["linha\nquebrada"]).toBe(1);
  });

  it("survives chunk splits inside quotes and inside fields", () => {
    const text = line({ 4: "abcdefghij", 11: "4712100" });
    // force every possible split point
    for (let split = 1; split < text.length - 1; split++) {
      const c = new LineCounter(FIELD_COUNT, { extract: [4] });
      c.push(text.slice(0, split));
      c.push(text.slice(split));
      c.flush();
      expect(c.lines, `split at ${split}`).toBe(1);
      expect(c.malformed, `split at ${split}`).toBe(0);
      expect(c.extracted[4], `split at ${split}`).toEqual({ abcdefghij: 1 });
    }
  });

  it("accepts CRLF line endings", () => {
    const text = line({ 4: "a", 11: "4712100" }).replace(/\n/g, "\r\n") + line();
    const c = countAll(text);
    expect(c.lines).toBe(2);
    expect(c.malformed).toBe(0);
  });

  it("produces identical counts no matter where chunks split (consistency property)", () => {
    const tricky = [
      line({ 4: "a;b;c", 11: "4712100" }),
      line({ 4: 'x"y"z', 11: "1" }).replace(/\n/g, "\r\n"),
      line({ 4: "linha\nquebrada", 11: "2" }),
      line(),
      "malformed short\n",
      line({ 4: "ação", 11: "3" }).trimEnd(), // no trailing newline at EOF
    ].join("");
    const reference = countAll(tricky, { extract: [4, 11] });
    for (let split = 1; split < tricky.length; split++) {
      const c = new LineCounter(FIELD_COUNT, { extract: [4, 11] });
      c.push(tricky.slice(0, split));
      c.push(tricky.slice(split));
      c.flush();
      expect(c.lines, `split at ${split}`).toBe(reference.lines);
      expect(c.malformed, `split at ${split}`).toBe(reference.malformed);
      expect(c.extracted[4], `split at ${split}`).toEqual(reference.extracted[4]);
      expect(c.extracted[11], `split at ${split}`).toEqual(reference.extracted[11]);
    }
  });
});

describe("LineCounter extraction", () => {
  it("aggregates values per requested field index", () => {
    const text =
      line({ 3: "1", 4: "A", 5: "02", 11: "4712100", 19: "BA", 20: "2927" }) +
      line({ 3: "2", 4: "B", 5: "02", 11: "5611201", 19: "SP", 20: "3550" }) +
      line({ 3: "1", 4: "A", 5: "08", 11: "4712100", 19: "BA", 20: "2927" });
    const c = countAll(text, { extract: [3, 5, 11, 19, 20] });
    expect(c.extracted[3]).toEqual({ "1": 2, "2": 1 });
    expect(c.extracted[5]).toEqual({ "02": 2, "08": 1 });
    expect(c.extracted[11]).toEqual({ "4712100": 2, "5611201": 1 });
    expect(c.extracted[19]).toEqual({ BA: 2, SP: 1 });
    expect(c.extracted[20]).toEqual({ "2927": 2, "3550": 1 });
  });

  it("counts empty extracted values under the empty key", () => {
    const c = countAll(line(), { extract: [19] });
    expect(c.extracted[19]).toEqual({ "": 1 });
  });

  it("skips registration when a malformed short line lacks the field", () => {
    const short = Array.from({ length: 5 }, () => '""').join(";") + "\n";
    const c = countAll(short, { extract: [19] });
    expect(c.malformed).toBe(1);
    expect(c.extracted[19]).toBeUndefined();
  });
});

describe("LineCounter byte offsets", () => {
  it("reports line starts with exact byte offsets including multibyte chars", () => {
    const first = line({ 4: "ação", 11: "4712100" });
    const text = first + line();
    const starts: number[] = [];
    const c = new LineCounter(FIELD_COUNT, { trackOffsets: true, onLineStart: (o) => starts.push(o) });
    // push in awkward chunk sizes to exercise cross-chunk state
    for (let i = 0; i < text.length; i += 9) c.push(text.slice(i, i + 9));
    c.flush();
    expect(c.lines).toBe(2);
    expect(starts[0]).toBe(0);
    // second line starts right after the first line's trailing newline
    expect(starts[1]).toBe(Buffer.byteLength(first, "utf8"));
    expect(starts[2]).toBe(Buffer.byteLength(text, "utf8"));
  });

  it("counts bytes exactly across the whole stream", () => {
    const text = line({ 4: "ação", 11: "4712100" }) + line() + line({ 4: "é" });
    const c = new LineCounter(FIELD_COUNT, { trackOffsets: true });
    c.push(text);
    c.flush();
    expect(c.bytes).toBe(Buffer.byteLength(text, "utf8"));
  });
});
