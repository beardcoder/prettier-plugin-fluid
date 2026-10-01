/**
 * Maps positions in the preprocessed HTML back to the Fluid template, e.g.
 * for parse errors. Offsets are zero-based UTF-16 indices; positions have a
 * 1-based line and column, like Prettier's error locations.
 */
import type { Origin, Position, Segment } from './types.js';

function toOffset(text: string, { line, column }: Position): number {
  let offset = 0;
  for (let current = 1; current < line; current++) {
    const next = text.indexOf('\n', offset);
    if (next === -1) break;
    offset = next + 1;
  }

  return offset + column - 1;
}

function toPosition(text: string, offset: number): Position {
  const before = text.slice(0, offset);
  const lineStart = before.lastIndexOf('\n') + 1;

  return { line: before.split('\n').length, column: offset - lineStart + 1 };
}

export interface PositionContext {
  /** The preprocessed HTML. */
  html: string;
  /** The template (part) it was made from. */
  source: string;
  /** The preprocessor's segments, sorted by position. */
  segments: readonly Segment[];
  /** Where `source` is taken from, if it is part of a template. */
  origin?: Origin | undefined;
}

/**
 * Maps a position in the preprocessed HTML back to the Fluid template.
 * Positions inside a placeholder map to its start.
 */
export function toSourcePosition(position: Position, { html, source, segments, origin }: PositionContext): Position {
  const { text, offset: start } = origin ?? { text: source, offset: 0 };
  const offset = toOffset(html, position);
  let delta = 0;
  for (const segment of segments) {
    if (offset < segment.htmlStart) break;
    if (offset < segment.htmlEnd) return toPosition(text, start + segment.sourceStart);
    delta = segment.sourceEnd - segment.htmlEnd;
  }

  return toPosition(text, start + Math.min(offset + delta, source.length));
}
