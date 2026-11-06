/**
 * Atomic structuring (D4 prototype).
 *
 * The RAG weight experiment showed structured/atomic entries (D4) are one of the
 * two highest-priority defects. Long free-form values are invisible in the digest
 * and retrieve poorly, so the write path splits oversized values into atomic
 * entries of at most ATOMIC_MAX characters without losing any character.
 *
 * `splitAtomic` is deterministic: `splitAtomic(text).join('') === text`.
 */

export const ATOMIC_MAX = 180;

const BREAK_CHARS = /[。！？!?；;\n，,]/;

/**
 * Split a long value into chunks of at most `max` characters, preferring to cut
 * right after sentence/clause punctuation. Concatenating the returned parts
 * reproduces the input exactly.
 */
export function splitAtomic(value, max = ATOMIC_MAX) {
  const text = String(value ?? '');
  if (text.length === 0) return [];
  if (text.length <= max) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > max) {
    // Prefer the last clause boundary within the tail half of the window.
    let cut = -1;
    const from = Math.max(1, Math.floor(max * 0.5));
    for (let i = max - 1; i >= from; i -= 1) {
      if (BREAK_CHARS.test(rest[i])) {
        cut = i + 1;
        break;
      }
    }
    if (cut <= 0) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}

/** True when a value is already atomic (no split needed). */
export function isAtomic(value, max = ATOMIC_MAX) {
  return String(value ?? '').length <= max;
}
