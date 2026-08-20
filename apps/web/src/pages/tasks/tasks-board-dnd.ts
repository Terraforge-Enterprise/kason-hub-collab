// Pure drag-and-drop position math for the tasks board (M7). Lives in its own
// module (not exported from the page component file) so it's unit-testable
// without tripping react-refresh/only-export-components on the page.

export type CardRect = { id: string; midY: number };

/**
 * Index at which the dragged card should be spliced into the target lane.
 *
 * The dragged card is EXCLUDED from the measured list first: the server
 * splices `position` into the lane WITHOUT the moving task, so on a same-lane
 * downward drag the naive midpoint scan (which still counts the dragged
 * card's own slot) would land one position too low.
 *
 * Returns the index of the first remaining card whose vertical midpoint is
 * below the drop Y; appends (length of remaining cards) when dropped below
 * all of them. Empty lane → 0.
 */
export function computeDropPosition(
  rects: CardRect[],
  clientY: number,
  draggedId: string,
): number {
  const others = rects.filter((r) => r.id !== draggedId);
  for (let i = 0; i < others.length; i += 1) {
    if (clientY < others[i].midY) return i;
  }
  return others.length;
}
