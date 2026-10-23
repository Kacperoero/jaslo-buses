/**
 * Normalizes a stop or direction name for comparisons:
 * lowercase, Polish diacritics folded to ASCII (ł → l, ó → o…), only letters and digits kept.
 * Example: "Jasło, Kościuszki" → "jaslokosciuszki"
 */
export function normalizeName(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .toLowerCase()
    .replace(/ł/g, 'l') // ł has no Unicode decomposition, so NFD does not handle it
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * True when two names refer to the same place: equal after normalization,
 * or one contains the other. Empty names never match anything.
 */
export function namesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

/** Escapes text so it can be safely inserted into an HTML string (e.g. a Leaflet popup). */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
