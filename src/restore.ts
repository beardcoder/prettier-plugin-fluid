/**
 * Turns the HTML Prettier formatted back into the Fluid template: removes the
 * hints, restores tag names and placeholders, re-indents multi-line
 * expressions and fixes attribute quotes. Refuses to return a result if Fluid
 * code got lost, duplicated or changed on the way.
 */
import { assetElementTags, isRawTextElement, isVoidElement } from './elements.js';
import { escapeRegExp, lineIndent, linesStartingInString, scanDeclaration, scanTag } from './lexer.js';
import type { Fragment, RawTextTags, RestoreState, SourceRange } from './types.js';

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
    restoreAssetTags(restoreTagNames(collapseHuggedElements(formatted).replace(hint, ''), state), state.rawTextTags),
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
 * Prettier cannot break a too long inline element without adding whitespace,
 * so it moves the brackets of its tags to the next line instead:
 *
 *     <strong
 *       class="…"
 *       ><em>text</em></strong
 *     >
 *
 * Such an element is put back on one line, even if that exceeds the print
 * width, as long as its content has no line break of its own. Only line
 * breaks inside tags are removed, so the rendered whitespace stays the same.
 *
 * @param html Formatted HTML with placeholders.
 */
function collapseHuggedElements(html: string): string {
  const tags: SourceRange[] = [];
  /** Line breaks outside of tag syntax, i.e. in content. */
  const breaks: number[] = [];
  const hugged: SourceRange[] = [];
  const stack: { name: string; start: number; hugged: boolean }[] = [];

  function addBreaks(start: number, end: number): void {
    for (let i = html.indexOf('\n', start); i !== -1 && i < end;) {
      breaks.push(i);
      i = html.indexOf('\n', i + 1);
    }
  }

  let i = 0;
  while (i < html.length) {
    if (html[i] === '\n') {
      breaks.push(i++);
      continue;
    }
    if (html[i] !== '<') {
      i++;
      continue;
    }
    const declaration = scanDeclaration(html, i);
    if (declaration) {
      addBreaks(i, declaration.end);
      i = declaration.end;
      continue;
    }
    const scanned = scanTag(html, i);
    if (scanned?.kind !== 'tag') {
      i++;
      continue;
    }
    const { end, closing } = scanned;
    const name = scanned.name.toLowerCase();
    const tag = html.slice(i, end);
    tags.push({ start: i, end });
    // Line breaks in attribute values are content, too.
    for (let j = i; j < end; j++) {
      if (html[j] === '"' || html[j] === "'") {
        const close = html.indexOf(html[j], j + 1);
        if (close === -1) break;
        addBreaks(j, close);
        j = close;
      }
    }
    if (closing) {
      let index = stack.length - 1;
      while (index >= 0 && stack[index].name !== name) {
        index--;
      }
      if (index >= 0) {
        const open = stack[index];
        stack.length = index;
        if (open.hugged || tag.includes('\n')) {
          hugged.push({ start: open.start, end });
        }
      }
    } else if (!scanned.selfClosing && !isVoidElement(name)) {
      stack.push({
        name,
        start: i,
        // `>` moved to the next line and directly followed by content.
        hugged: /\n[ \t]*>$/.test(tag) && !/^(?:\n|<\/|$)/.test(html.slice(end, end + 2)),
      });
      if (isRawTextElement(name)) {
        const close = html.toLowerCase().indexOf(`</${name}`, end);
        const stop = close === -1 ? html.length : close;
        addBreaks(end, stop);
        i = stop;
        continue;
      }
    }
    i = end;
  }

  function hasBreak(range: SourceRange): boolean {
    let low = 0;
    let high = breaks.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (breaks[mid] < range.start) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    return low < breaks.length && breaks[low] < range.end;
  }
  // Outermost elements only; nested ones are part of them.
  const ranges: SourceRange[] = [];
  for (const range of hugged.filter((range) => !hasBreak(range)).sort((a, b) => a.start - b.start)) {
    if (range.start >= (ranges.at(-1)?.end ?? 0)) {
      ranges.push(range);
    }
  }
  if (ranges.length === 0) return html;

  let result = '';
  let copied = 0;
  let next = 0;
  for (const tag of tags) {
    while (next < ranges.length && ranges[next].end <= tag.start) {
      next++;
    }
    if (next === ranges.length) break;
    const text = html.slice(tag.start, tag.end);
    if (tag.start < ranges[next].start || !text.includes('\n')) continue;
    result += html.slice(copied, tag.start) + text.replace(/[ \t]*\n[ \t]*/g, ' ').replace(/ >$/, '>');
    copied = tag.end;
  }

  return result + html.slice(copied);
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
