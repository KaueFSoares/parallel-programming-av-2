import { LineCounter } from "./counter.js";
import { FIELD_COUNT } from "../shared/types.js";

/** A record-aligned byte range within one raw file. */
export interface ScanUnit {
  offset: number;
  length: number;
  rows: number;
}

/**
 * Splits a single CSV byte stream into record-aligned units.
 *
 * A unit is closed when a line starts at byte offset `O` and the current unit
 * would already be at least `targetBytes` long (`O - unitStart >= targetBytes`).
 * Units therefore start at line starts and contain whole records only; the last
 * unit is closed by `finish()` and may be shorter than the target.
 *
 * Byte offsets come from `LineCounter` with `trackOffsets`, which counts exact
 * UTF-8 bytes and fires `onLineStart` for every record boundary (including 0).
 */
export class UnitScanner {
  /** S3 key of the raw file this scanner covers (units themselves are key-less). */
  readonly key: string;

  private readonly targetBytes: number;
  private readonly counter: LineCounter;
  private readonly units: ScanUnit[] = [];
  private unitStart = 0;
  private unitStartRows = 0;

  constructor(targetBytes: number, key: string) {
    if (!Number.isFinite(targetBytes) || targetBytes <= 0) {
      throw new Error(`targetBytes must be a positive finite number (got ${targetBytes})`);
    }
    this.targetBytes = targetBytes;
    this.key = key;
    this.counter = new LineCounter(FIELD_COUNT, {
      trackOffsets: true,
      onLineStart: (offset) => this.handleLineStart(offset),
    });
  }

  /** Push a decoded string chunk. State persists across chunks. */
  push(s: string): void {
    this.counter.push(s);
  }

  /** Flush pending parser state, close the final unit, and return all units. */
  finish(): ScanUnit[] {
    this.counter.flush();
    if (this.counter.lines > this.unitStartRows) {
      this.units.push({
        offset: this.unitStart,
        length: this.counter.bytes - this.unitStart,
        rows: this.counter.lines - this.unitStartRows,
      });
      this.unitStart = this.counter.bytes;
      this.unitStartRows = this.counter.lines;
    }
    return this.units;
  }

  private handleLineStart(offset: number): void {
    if (offset - this.unitStart < this.targetBytes) return;
    this.units.push({
      offset: this.unitStart,
      length: offset - this.unitStart,
      rows: this.counter.lines - this.unitStartRows,
    });
    this.unitStart = offset;
    this.unitStartRows = this.counter.lines;
  }
}
