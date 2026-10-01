/**
 * Data structures shared by preprocessing, restoring and position mapping.
 *
 * Offsets are zero-based UTF-16 indices into a string and ranges end
 * exclusively, like the arguments of `String#slice`.
 */

export interface SourceRange {
  start: number;
  end: number;
}

/** Template code a placeholder stands for. */
export interface Fragment {
  /** Original template code. */
  source: string;
  /** Whether the placeholder is wrapped in `<!-- -->`. */
  comment: boolean;
  /**
   * Leading whitespace of the source line the code starts on; continuation
   * lines of expressions move with the new indent.
   */
  indent: number;
  /** How often the placeholder occurs in the HTML; equal code shares one placeholder. */
  count: number;
}

/** Code the preprocessor replaced or inserted. */
export interface Segment {
  htmlStart: number;
  htmlEnd: number;
  sourceStart: number;
  sourceEnd: number;
}

export interface RawTextTags {
  /** All `<style>`/`<script>` tags (opening and closing) in the preprocessed HTML. */
  count: number;
  /** Original tag name by the ordinal of the renamed tags among them. */
  assets: Map<number, string>;
}

/** What `restore()` needs to turn the formatted HTML back into Fluid. */
export interface RestoreState {
  /** The original template. */
  source: string;
  nonce: string;
  /** Namespaces whose tags were renamed to `ns-name` rather than `ns-<nonce>-name`. */
  namespaces: string[];
  /** Comments inserted to steer Prettier. */
  hints: string[];
  fragments: Fragment[];
  /** Sorted by position. */
  segments: Segment[];
  /** `<f:asset.css>`/`<f:asset.script>` tags temporarily turned into `<style>`/`<script>`. */
  rawTextTags: RawTextTags;
}

/** 1-based line and column, as in Prettier's error locations. */
export interface Position {
  line: number;
  column: number;
}

/** Where a formatted part of a template is taken from. */
export interface Origin {
  /** The whole template. */
  text: string;
  /** Offset of the part in it. */
  offset: number;
}
