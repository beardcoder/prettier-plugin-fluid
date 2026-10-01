/**
 * Turns the HTML Prettier formatted back into the Fluid template: removes the
 * hints, restores tag names and placeholders, re-indents multi-line
 * expressions and fixes attribute quotes. Refuses to return a result if Fluid
 * code got lost, duplicated or changed on the way.
 */
import { assetElementTags } from './elements.js';
import { escapeRegExp, lineIndent, linesStartingInString } from './lexer.js';
import type { Fragment, RawTextTags, RestoreState } from './types.js';

/** Reverses `preprocess()` on the formatted HTML. */
export function restore(formatted: string, state: RestoreState): string {
  const { nonce, hints, fragments } = state;
  const hint = new RegExp(`(?:${hints.map(escapeRegExp).join('|')})(?:\\n[ \\t]*)?`, 'g');
  const placeholder = new RegExp(`(<!--)?${nonce}(\\d+)_*${nonce}(-->)?`, 'g');
  // Equal code shares a placeholder, so compare how often each one occurs.
  const counts = fragments.map(() => 0);
  const unknown: string[] = [];
  /** Comment placeholders Prettier took out of their `<!-- -->`. */
  const unwrapped: string[] = [];

  const text = fixAttributeQuotes(
    restoreAssetTags(restoreTagNames(formatted.replace(hint, ''), state), state.rawTextTags),
    state,
  );
  const result = text.replace(
    placeholder,
    (match: string, open: string | undefined, id: string, close: string | undefined, offset: number) => {
      const fragment = fragments[Number(id)];
      if (!fragment) {
        unknown.push(match);

        return match;
      }
      if (!fragment.comment) {
        counts[Number(id)]++;
        const source = reindent(fragment, lineIndent(text, offset));

        return `${open ?? ''}${source}${close ?? ''}`;
      }
      if (open && close) {
        counts[Number(id)]++;

        return fragment.source;
      }
      unwrapped.push(fragment.source);

      return match;
    },
  );

  const problems: string[] = [];
  function report(problem: string, codes: string[]): void {
    if (codes.length > 0) problems.push(`${problem}: ${codes.join(', ')}`);
  }
  function sources(test: (count: number, expected: number) => boolean): string[] {
    return fragments.filter(({ count }, id) => test(counts[id], count)).map(({ source }) => source);
  }
  report(
    'dropped Fluid code',
    sources((count, expected) => count < expected),
  );
  report(
    'duplicated Fluid code',
    sources((count, expected) => count > expected),
  );
  report('produced unknown placeholders', unknown);
  report('took Fluid code out of its HTML comment', unwrapped);
  if (problems.length > 0) {
    throw new Error(`prettier-plugin-fluid: formatting ${problems.join('; ')}. Refusing to continue.`);
  }

  return result;
}

/**
 * Replaces placeholders and renamed tags in arbitrary text (e.g. error
 * messages) without the completeness check of `restore()`.
 */
export function revealPlaceholders(text: string, { nonce, namespaces, fragments }: RestoreState): string {
  return restoreTagNames(text, { nonce, namespaces }).replace(
    new RegExp(`${nonce}(\\d+)_*${nonce}`, 'g'),
    (match, id: string) => fragments[Number(id)]?.source ?? match,
  );
}

/**
 * Moves the continuation lines of a multi-line expression by the change in
 * indentation of its first line, keeping their relative layout.
 */
function reindent({ source, indent }: Fragment, newIndent: string): string {
  const delta = newIndent.length - indent;
  if (delta === 0 || !source.includes('\n')) return source;
  const [first, ...rest] = source.split('\n');
  const unit = newIndent.includes('\t') ? '\t' : ' ';
  const inString = linesStartingInString(source);
  const moved = rest.map((line, index) => {
    // Whitespace inside a string literal is output; leave those lines alone.
    if (line.trim() === '' || inString[index + 1]) return line;
    if (delta > 0) return unit.repeat(delta) + line;
    const removable = /^[ \t]*/.exec(line)?.[0].length ?? 0;

    return line.slice(Math.min(-delta, removable));
  });

  return [first, ...moved].join('\n');
}

/**
 * Prettier picks the quotes of an attribute value by the quotes it contains,
 * but cannot see quotes inside placeholders. A value like '{"w":"1"}' would be
 * printed as "…" and turn into invalid HTML once restored, so switch such
 * values to the other quote character. Fails if neither quote works.
 *
 * @param text Formatted HTML with placeholders.
 */
function fixAttributeQuotes(text: string, { source, nonce, fragments }: RestoreState): string {
  const placeholder = new RegExp(`${nonce}(\\d+)_*${nonce}`, 'g');
  const quoted = new RegExp(`=(["'])([^"'\\n]*?${nonce}\\d+_*${nonce}[^\\n]*?)\\1`, 'g');

  return text.replace(quoted, (match, quote: string, value: string) => {
    const other = quote === '"' ? "'" : '"';
    const full = value.replace(
      placeholder,
      (match, id: string) =>
        // Unknown placeholders are reported by `restore()`.
        fragments[Number(id)]?.source ?? match,
    );
    if (!hasRaw(full, quote)) return match;
    const entity = quote === '"' ? '&quot;' : '&apos;';
    const unescaped = value.replaceAll(entity, quote);
    const unescapedFull = full.replaceAll(entity, quote);
    if (hasRaw(unescapedFull, other)) {
      // No quote character works. Fine if the template already had it so
      // (Fluid accepts it); otherwise refuse to write invalid HTML.
      if (source.includes(`${quote}${unescapedFull}${quote}`)) return match;
      throw new Error(
        `prettier-plugin-fluid: cannot quote the attribute value ${full}: it contains both quote characters. Refusing to write invalid HTML.`,
      );
    }

    return `=${other}${unescaped}${other}`;
  });
}

/** Whether `text` contains `char` without a backslash before it. */
function hasRaw(text: string, char: string): boolean {
  // Backslash-escaped quotes are Fluid syntax (`"{a: \\"b\\"}"`) and fine.
  return new RegExp(`(?<!\\\\)${char}`).test(text);
}

/** Turns renamed ViewHelper tags (`f-if`, `f-qz-if`) back into `f:if`. */
function restoreTagNames(text: string, { nonce, namespaces }: Pick<RestoreState, 'nonce' | 'namespaces'>): string {
  const restored = text.replace(new RegExp(`([a-zA-Z0-9.]+)-${nonce}-`, 'g'), '$1:');
  if (namespaces.length === 0) return restored;
  const tags = new RegExp(`(</?)(${namespaces.map(escapeRegExp).join('|')})-`, 'g');

  return restored.replace(tags, '$1$2:');
}

/**
 * Turns the `<style>`/`<script>` tags that were `<f:asset.css>`/
 * `<f:asset.script>` back. Prettier keeps the order of elements, so the tags
 * are identified by their position among all `<style>`/`<script>` tags.
 */
function restoreAssetTags(text: string, { count, assets }: RawTextTags): string {
  if (assets.size === 0) return text;
  let ordinal = 0;
  const result = text.replace(assetElementTags(), (match) => {
    const name = assets.get(ordinal++);

    return name ? `<${name}` : match;
  });
  if (ordinal !== count) {
    throw new Error(
      'prettier-plugin-fluid: formatting changed the number of <style>/<script> tags, refusing to continue.',
    );
  }

  return result;
}
