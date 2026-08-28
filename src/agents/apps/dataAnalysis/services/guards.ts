/**
 * Pure host-side guardrails for the Data Analysis app.
 *
 * No Obsidian / Pyodide dependencies here — these are deterministic functions
 * that bound the tool's inputs and outputs, and are fully unit-tested.
 */

import { DATA_ANALYSIS_DEFAULTS } from '../types';
import { isValidPath } from '../../../../utils/pathUtils';

/**
 * Number grouping is pinned rather than left to the machine.
 *
 * These strings are not UI: they are returned to the model as the reason a call
 * was refused, alongside English instructions it has to act on. Bare
 * `toLocaleString()` reads the host's locale, so the same refusal came back as
 * "8,432 rows" on one machine and "8.432 rows" on another — which also made the
 * file's own claim to be deterministic false, and the unit tests pass or fail by
 * whoever ran them. UI elsewhere in the plugin deliberately keeps following the
 * user's locale; a protocol string cannot.
 */
const MESSAGE_LOCALE = 'en-US';

export interface RowCapOutcome {
  ok: boolean;
  rowCount: number | null;
  error?: string;
}

/**
 * Count the "rows" of a marshalled result. An array of records is the canonical
 * row collection; anything else (scalar, single object) is uncapped.
 */
export function countResultRows(data: unknown): number | null {
  return Array.isArray(data) ? data.length : null;
}

/**
 * The 1500-row guardrail. JSONSchema can't validate a computed output, so this
 * runs host-side on the returned value and nudges callers toward aggregation.
 */
export function enforceRowCap(data: unknown, maxRows: number): RowCapOutcome {
  const rowCount = countResultRows(data);
  if (rowCount !== null && rowCount > maxRows) {
    return {
      ok: false,
      rowCount,
      error:
        `Result has ${rowCount.toLocaleString(MESSAGE_LOCALE)} rows ` +
        `(max ${maxRows.toLocaleString(MESSAGE_LOCALE)}). ` +
        `Aggregate (groupby/pivot/describe) or add a filter/limit and re-run.`,
    };
  }
  return { ok: true, rowCount };
}

export interface OutputBudgetOutcome {
  ok: boolean;
  bytes: number;
  error?: string;
}

/**
 * Universal output backstop. The row cap only bounds top-level arrays — a
 * `{rows: [...]}` or `df.to_dict()` shape would otherwise dump unbounded data
 * into context. This caps the serialized size of ANY result shape.
 */
export function enforceOutputBudget(data: unknown, maxBytes: number): OutputBudgetOutcome {
  let serialized: string;
  try {
    serialized = JSON.stringify(data) ?? 'null';
  } catch {
    return { ok: false, bytes: 0, error: 'Result is not JSON-serializable.' };
  }
  const bytes = serialized.length;
  if (bytes > maxBytes) {
    return {
      ok: false,
      bytes,
      error:
        `Result is ${Math.round(bytes / 1024).toLocaleString(MESSAGE_LOCALE)}KB ` +
        `(max ${Math.round(maxBytes / 1024).toLocaleString(MESSAGE_LOCALE)}KB). ` +
        `Aggregate or reduce the columns/rows returned and re-run.`,
    };
  }
  return { ok: true, bytes };
}

export function clampMaxRows(requested: number | undefined): number {
  const { maxRows, maxRowsHardCap } = DATA_ANALYSIS_DEFAULTS;
  return isPositive(requested) ? Math.min(Math.floor(requested), maxRowsHardCap) : maxRows;
}

export function clampOutputBytes(requested: number | undefined): number {
  const { maxOutputBytes, maxOutputBytesHardCap } = DATA_ANALYSIS_DEFAULTS;
  return isPositive(requested) ? Math.min(Math.floor(requested), maxOutputBytesHardCap) : maxOutputBytes;
}

export function clampInputBytes(requested: number | undefined): number {
  const { maxInputBytes, maxInputBytesHardCap } = DATA_ANALYSIS_DEFAULTS;
  return isPositive(requested) ? Math.min(Math.floor(requested), maxInputBytesHardCap) : maxInputBytes;
}

export function clampTimeout(requested: number | undefined): number {
  const { timeoutMs, timeoutHardCapMs } = DATA_ANALYSIS_DEFAULTS;
  return isPositive(requested) ? Math.min(Math.floor(requested), timeoutHardCapMs) : timeoutMs;
}

function isPositive(n: number | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 1;
}

export interface InputValidation {
  ok: boolean;
  error?: string;
}

/** Reject traversal / absolute / illegal input paths before the host reads them. */
export function validateInputPath(path: string): InputValidation {
  if (!isValidPath(path)) {
    return {
      ok: false,
      error: `Invalid input path: "${path}" — must be vault-relative, no ".." or absolute paths`,
    };
  }
  return { ok: true };
}

/**
 * Derive the in-sandbox filename for an input. Keeps the source extension so the
 * user's choice of `pd.read_csv` vs `pd.read_excel` lines up with the bytes.
 */
export function sandboxFileName(varName: string, sourcePath: string): string {
  const lastSlash = sourcePath.lastIndexOf('/');
  const dot = sourcePath.lastIndexOf('.');
  const ext = dot > lastSlash ? sourcePath.slice(dot) : '';
  const cleaned = varName.replace(/[^A-Za-z0-9_]/g, '_');
  const safe = /[A-Za-z0-9]/.test(cleaned) ? cleaned : 'input';
  return `${safe}${ext}`;
}

export function formatBytesMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}
