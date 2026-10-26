// path: src/app/ui/category-gradient.ts

/**
 * Cover art for scenarios without a preview image, one per seeded category. The gradients are the
 * prototype's own scenario covers (solar system, plant cell, pendulum, periodic table, fortress,
 * induction, atom), so a card and a scenario page agree on what "no image" looks like.
 */
const CATEGORY_GRADIENTS: Readonly<Record<string, string>> = {
  astronomy: `radial-gradient(circle at 68% 34%,rgba(255,196,120,.55),transparent 42%),radial-gradient(circle at 30% 72%,rgba(145,132,217,.42),transparent 48%),linear-gradient(150deg,#2a2450,#14152a 62%,#0f1020)`,
  biology: `radial-gradient(circle at 34% 40%,rgba(126,214,178,.42),transparent 46%),radial-gradient(circle at 74% 74%,rgba(145,132,217,.34),transparent 44%),linear-gradient(160deg,#1a2e33,#141d2b 58%,#0f1020)`,
  physics: `conic-gradient(from 210deg at 50% 50%,rgba(145,132,217,.36),transparent 38%,rgba(167,161,219,.3) 72%,transparent),linear-gradient(140deg,#232a52,#161a30 56%,#0f1020)`,
  chemistry: `repeating-linear-gradient(90deg,rgba(233,233,237,.05) 0 1px,transparent 1px 22px),repeating-linear-gradient(0deg,rgba(233,233,237,.05) 0 1px,transparent 1px 22px),radial-gradient(circle at 66% 30%,rgba(190,130,220,.4),transparent 50%),linear-gradient(150deg,#2e2044,#181530 60%,#0f1020)`,
  history: `linear-gradient(200deg,rgba(214,166,106,.34),transparent 46%),radial-gradient(circle at 22% 78%,rgba(145,132,217,.28),transparent 46%),linear-gradient(160deg,#3a2c22,#221c2c 54%,#0f1020)`,
  test: `repeating-radial-gradient(circle at 38% 50%,rgba(145,132,217,.22) 0 2px,transparent 2px 16px),linear-gradient(140deg,#1e2747,#151a2e 56%,#0f1020)`,
  other: `radial-gradient(circle at 50% 50%,rgba(145,132,217,.44),transparent 42%),linear-gradient(150deg,#251f3e,#16162c 58%,#0f1020)`,
};

/** Slugs the platform does not know get one of the same covers, chosen by a stable hash. */
const GRADIENT_POOL = Object.values(CATEGORY_GRADIENTS);

/** A CSS `background` value for a category slug. Total: any string, including `''`, yields a gradient. */
export function categoryGradient(slug: string): string {
  const known = Object.hasOwn(CATEGORY_GRADIENTS, slug) ? CATEGORY_GRADIENTS[slug] : undefined;
  if (known) return known;

  let hash = 0;
  for (const char of slug ?? '') hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return GRADIENT_POOL[hash % GRADIENT_POOL.length];
}
