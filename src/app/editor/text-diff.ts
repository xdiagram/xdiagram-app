/** A single replacement turning `oldText` into `newText`: `oldText[start, end)` → `text`. */
export interface TextChange {
  start: number;
  end: number;
  text: string;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * The smallest single-range change between two texts (common prefix and suffix trimmed),
 * so programmatic edits touch only what changed and stay one tidy undo step in the editor.
 * Never splits a UTF-16 surrogate pair.
 */
export function diffRange(oldText: string, newText: string): TextChange | null {
  if (oldText === newText) return null;
  const max = Math.min(oldText.length, newText.length);
  let start = 0;
  while (start < max && oldText.charCodeAt(start) === newText.charCodeAt(start)) start++;
  if (start > 0 && isHighSurrogate(oldText.charCodeAt(start - 1))) start--;

  let endOld = oldText.length;
  let endNew = newText.length;
  while (endOld > start && endNew > start && oldText.charCodeAt(endOld - 1) === newText.charCodeAt(endNew - 1)) {
    endOld--;
    endNew--;
  }
  if (endOld < oldText.length && isLowSurrogate(oldText.charCodeAt(endOld))) {
    endOld++;
    endNew++;
  }
  return { start, end: endOld, text: newText.slice(start, endNew) };
}

export function applyChange(oldText: string, change: TextChange): string {
  return oldText.slice(0, change.start) + change.text + oldText.slice(change.end);
}
