/**
 * Pure helpers for the per-user dashboard tile order. The server stores the order and only
 * ever returns reports the user can see; these helpers just rearrange what was loaded.
 */

interface Positioned {
  id: string;
  tilePos?: number | null;
}

/**
 * The user's whole-dashboard order: reports with a saved position first (by position), then
 * the rest in the order they were loaded (owned before shared, default sort within each).
 */
export function initialTileOrder(reports: Positioned[]): string[] {
  return reports
    .map((r, i) => ({ id: r.id, i, p: r.tilePos ?? null }))
    .sort((a, b) => {
      if (a.p !== null && b.p !== null) return a.p - b.p || a.i - b.i;
      if (a.p !== null) return -1;
      if (b.p !== null) return 1;
      return a.i - b.i;
    })
    .map((x) => x.id);
}

/** Sort a list by a whole-dashboard order; ids missing from the order keep their place at the end. */
export function sortByOrder<R extends { id: string }>(items: R[], order: string[]): R[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  return items
    .map((r, i) => ({ r, i, k: rank.get(r.id) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map((x) => x.r);
}

/** Move `id` to just before (or after) `target` within one section's ids. */
export function moveBefore(ids: string[], id: string, target: string, after = false): string[] {
  if (id === target || !ids.includes(id) || !ids.includes(target)) return ids;
  const rest = ids.filter((x) => x !== id);
  const at = rest.indexOf(target) + (after ? 1 : 0);
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/** Move `id` by `delta` places within one section's ids (clamped at the ends). */
export function moveBy(ids: string[], id: string, delta: number): string[] {
  const from = ids.indexOf(id);
  if (from < 0) return ids;
  const to = Math.max(0, Math.min(ids.length - 1, from + delta));
  if (to === from) return ids;
  const rest = ids.filter((x) => x !== id);
  return [...rest.slice(0, to), id, ...rest.slice(to)];
}

/**
 * Apply a rearranged section (Favorites, a folder, My reports, a filtered view, ...) to the
 * whole-dashboard order. The section's tiles keep the slots they already occupied in the whole
 * order and are refilled in their new order, so tiles outside the section never move.
 */
export function mergeSectionOrder(order: string[], section: string[]): string[] {
  const inSection = new Set(section);
  const missing = section.filter((id) => !order.includes(id));
  const whole = [...order, ...missing];
  let next = 0;
  return whole.map((id) => (inSection.has(id) ? section[next++] : id));
}
