/**
 * Streaming, quote-aware line counter for the RFB Estabelecimentos format:
 * semicolon-delimited, all fields double-quoted, one record per line, no header.
 *
 * Used by:
 *  - preparation (trackOffsets=true): record-aligned byte ranges + row counts;
 *  - workers (extract=[...]): per-dimension counts over a byte range.
 *
 * Parser semantics (CSV-style):
 *  - `;` outside quotes separates fields; `"..."` quotes a field;
 *  - `""` inside a quoted field is an escaped quote;
 *  - a newline inside a quoted field is field content, not a record boundary;
 *  - a record whose field count != expectedFields is counted as malformed.
 */
import { FIELD_COUNT } from "../shared/types.js";

const QUOTE = 34; // "
const SEMI = 59; // ;
const LF = 10; // \n
const CR = 13; // \r

export interface CounterOptions {
  /** Field indexes (0-based) whose values are aggregated into `extracted`. */
  extract?: readonly number[];
  /** Track byte offsets; `onLineStart` receives the byte offset of each line start. */
  trackOffsets?: boolean;
  onLineStart?: (byteOffset: number) => void;
}

export class LineCounter {
  lines = 0;
  malformed = 0;
  /** Bytes consumed (exact when trackOffsets is enabled). */
  bytes = 0;
  /** Per-field-index value counts: extracted[i] = { value: count }. */
  extracted: (Record<string, number> | undefined)[];

  private readonly expected: number;
  private readonly extractSet: Set<number>;
  private readonly track: boolean;
  private readonly onLineStart?: (byteOffset: number) => void;

  private inQuotes = false;
  private quoteEsc = false; // a closing quote was just seen; next quote is escaped
  private crPending = false; // a CR at chunk end; next chunk may start with the LF
  private fieldCount = 0;
  private capturing = false;
  private fieldChars: string[] | null = null;
  private lineValues: (string | undefined)[] = [];
  private lineHasContent = false;

  constructor(expected: number = FIELD_COUNT, opts: CounterOptions = {}) {
    this.expected = expected;
    this.extractSet = new Set(opts.extract ?? []);
    this.extracted = [];
    this.track = opts.trackOffsets ?? false;
    this.onLineStart = opts.onLineStart;
    if (this.track) this.onLineStart?.(0);
  }

  /** Push a decoded string chunk. State persists across chunks. */
  push(s: string): void {
    const n = s.length;
    const track = this.track;
    let i = 0;
    if (this.crPending) {
      this.crPending = false;
      if (n > 0 && s.charCodeAt(0) === LF) {
        i = 1;
        if (track) this.bytes++;
      }
    }
    while (i < n) {
      const c = s.charCodeAt(i);
      if (this.quoteEsc && c !== QUOTE) this.quoteEsc = false;
      if (this.inQuotes) {
        if (c === QUOTE) {
          this.inQuotes = false;
          this.quoteEsc = true;
          i++;
          if (track) this.bytes++;
          continue;
        }
        const units = charUnits(s, i);
        if (this.capturing) this.fieldChars!.push(units === 2 ? s.slice(i, i + 2) : s[i]);
        i += units;
        if (track) this.bytes += charBytes(s, i - units);
        this.lineHasContent = true;
        continue;
      }
      if (c === QUOTE) {
        if (this.quoteEsc) {
          // escaped quote: quote content, stay inside the quoted field
          this.quoteEsc = false;
          this.inQuotes = true;
          if (this.capturing) this.fieldChars!.push('"');
          this.lineHasContent = true;
          i++;
          if (track) this.bytes++;
          continue;
        }
        this.inQuotes = true;
        this.lineHasContent = true;
        i++;
        if (track) this.bytes++;
        continue;
      }
      if (c === SEMI) {
        this.endField();
        i++;
        if (track) this.bytes++;
        continue;
      }
      if (c === LF) {
        this.endField();
        i++;
        if (track) this.bytes++;
        this.endLine();
        continue;
      }
      if (c === CR) {
        // CR outside quotes: line end (optionally followed by LF).
        i++;
        if (track) this.bytes++;
        if (i < n) {
          if (s.charCodeAt(i) === LF) {
            i++;
            if (track) this.bytes++;
          }
        } else {
          this.crPending = true;
        }
        this.endField();
        this.endLine();
        continue;
      }
      const units = charUnits(s, i);
      if (this.capturing) this.fieldChars!.push(units === 2 ? s.slice(i, i + 2) : s[i]);
      i += units;
      if (track) this.bytes += charBytes(s, i - units);
      this.lineHasContent = true;
    }
  }

  /** Finalize a trailing line without a line terminator. */
  flush(): void {
    if (this.lineHasContent || this.fieldCount > 0 || this.inQuotes) {
      this.endField();
      this.endLine();
    }
  }

  private endField(): void {
    const idx = this.fieldCount;
    if (this.capturing && this.fieldChars) {
      const value = this.fieldChars.join("");
      this.lineValues[idx] = value;
      this.fieldChars = null;
    }
    this.fieldCount++;
    this.capturing = this.extractSet.has(this.fieldCount);
    if (this.capturing) this.fieldChars = [];
    this.lineHasContent = true; // a delimiter counts as line content
  }

  private endLine(): void {
    this.lines++;
    if (this.fieldCount !== this.expected) this.malformed++;
    for (const idx of this.extractSet) {
      const v = this.lineValues[idx];
      if (v !== undefined) {
        const bucket = (this.extracted[idx] ??= {});
        bucket[v] = (bucket[v] ?? 0) + 1;
      }
    }
    // reset for next line
    this.fieldCount = 0;
    this.lineValues = [];
    this.lineHasContent = false;
    this.inQuotes = false;
    this.quoteEsc = false;
    this.fieldChars = null;
    this.capturing = this.extractSet.has(0);
    if (this.capturing) this.fieldChars = [];
    if (this.track) this.onLineStart?.(this.bytes);
  }
}

/** UTF-16 code units consumed by the character at index i (2 for surrogate pairs). */
function charUnits(s: string, i: number): number {
  const c = s.charCodeAt(i);
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
    const lo = s.charCodeAt(i + 1);
    if (lo >= 0xdc00 && lo <= 0xdfff) return 2;
  }
  return 1;
}

/** UTF-8 byte length of the character at index i. */
function charBytes(s: string, i: number): number {
  const c = s.charCodeAt(i);
  if (c < 0x80) return 1;
  if (c < 0x800) return 2;
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
    const lo = s.charCodeAt(i + 1);
    if (lo >= 0xdc00 && lo <= 0xdfff) return 4;
  }
  return 3;
}
