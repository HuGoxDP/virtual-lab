// path: src/app/services/catalog-query.spec.ts
//
// Covers test-plan scenario 120 (release 1, phase 3 - DW-3.2): the catalog URL's query string and
// the filter it stands for convert both ways without loss, and junk in the URL falls back to defaults.

import { DEFAULT_CATALOG_FILTER, MAX_QUERY_LENGTH, parseCatalogQuery, sameCatalogFilter, toCatalogQuery } from './catalog-query';

describe('catalog query', () => {
  it('DW-3.2 an empty query is the default filter', () => {
    expect(parseCatalogQuery({})).toEqual(DEFAULT_CATALOG_FILTER);
  });

  it('DW-3.2 a filter survives filter -> params -> filter', () => {
    const filter = { category: 'physics', q: 'маятник', sort: 'title' as const };
    expect(parseCatalogQuery(toCatalogQuery(filter))).toEqual(filter);
  });

  it('DW-3.2 default values are dropped from the URL (null removes a router parameter)', () => {
    expect(toCatalogQuery(DEFAULT_CATALOG_FILTER)).toEqual({ category: null, q: null, sort: null });
    expect(toCatalogQuery({ category: 'all', q: '  ', sort: 'new' })).toEqual({ category: null, q: null, sort: null });
  });

  it('only non-default parts are written', () => {
    expect(toCatalogQuery({ category: 'biology', q: '', sort: 'new' })).toEqual({ category: 'biology', q: null, sort: null });
  });

  it('trims the search text and cuts it to the length limit', () => {
    expect(parseCatalogQuery({ q: '  клітина  ' }).q).toBe('клітина');
    expect(parseCatalogQuery({ q: 'я'.repeat(MAX_QUERY_LENGTH + 50) }).q).toHaveLength(MAX_QUERY_LENGTH);
  });

  it('an unknown or missing sort is "new"; only "title" selects the other order', () => {
    expect(parseCatalogQuery({ sort: 'DROP TABLE' }).sort).toBe('new');
    expect(parseCatalogQuery({ sort: '' }).sort).toBe('new');
    expect(parseCatalogQuery({ sort: 'title' }).sort).toBe('title');
  });

  it('repeated and non-string parameters use the first string value or the default', () => {
    expect(parseCatalogQuery({ category: ['physics', 'biology'] }).category).toBe('physics');
    expect(parseCatalogQuery({ q: [] }).q).toBe('');
    expect(parseCatalogQuery({ category: 5, sort: {} } as never)).toEqual(DEFAULT_CATALOG_FILTER);
  });

  it('an empty or blank category is "all"', () => {
    expect(parseCatalogQuery({ category: '   ' }).category).toBe('all');
  });

  it('sameCatalogFilter compares all three parts', () => {
    const a = { category: 'a', q: 'b', sort: 'new' as const };
    expect(sameCatalogFilter(a, { ...a })).toBe(true);
    expect(sameCatalogFilter(a, { ...a, category: 'x' })).toBe(false);
    expect(sameCatalogFilter(a, { ...a, q: 'x' })).toBe(false);
    expect(sameCatalogFilter(a, { ...a, sort: 'title' })).toBe(false);
  });
});
