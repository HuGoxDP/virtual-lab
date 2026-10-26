// path: src/app/ui/category-gradient.spec.ts
//
// Covers test-plan scenario 117.
//
// Release 1, phase 2 - DW-2.4: a card without a preview has a cover; it is stable per category.

import { categoryGradient } from './category-gradient';

describe('categoryGradient', () => {
  const seeded = ['physics', 'biology', 'chemistry', 'history', 'astronomy', 'test', 'other'];

  it('DW-2.4 gives each seeded category its own CSS gradient', () => {
    const gradients = seeded.map(categoryGradient);
    for (const gradient of gradients) expect(gradient).toMatch(/gradient\(/);
    expect(new Set(gradients).size).toBe(seeded.length);
  });

  it('is stable: the same slug always yields the same gradient', () => {
    expect(categoryGradient('physics')).toBe(categoryGradient('physics'));
    expect(categoryGradient('my-new-category')).toBe(categoryGradient('my-new-category'));
  });

  it('is total: unknown, empty and prototype-chain slugs still yield a gradient', () => {
    for (const slug of ['', 'нова категорія', 'constructor', '__proto__', 'toString', 'x'.repeat(500)]) {
      expect(categoryGradient(slug), slug).toMatch(/gradient\(/);
    }
  });
});
