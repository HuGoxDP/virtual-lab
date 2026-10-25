// path: src/app/services/catalog-query.ts

import { Params } from '@angular/router';

export type CatalogSort = 'new' | 'title';

/** What the server filters and orders by. All three live in the catalog URL's query string. */
export interface CatalogFilter {
  /** Category slug; `'all'` means no category filter. */
  category: string;
  /** Search text, trimmed; `''` means none. */
  q: string;
  sort: CatalogSort;
}

export const DEFAULT_CATALOG_FILTER: CatalogFilter = { category: 'all', q: '', sort: 'new' };

/** The URL is user input: a longer search string is cut rather than sent to the server. */
export const MAX_QUERY_LENGTH = 100;

/** First value of a query parameter; `?q=a&q=b` and `?q` yield the first / nothing. */
function first(value: unknown): string {
  const single = Array.isArray(value) ? value[0] : value;
  return typeof single === 'string' ? single : '';
}

/**
 * Reads a filter from query parameters. Total: junk, repeats and unknown sort keys fall back to the
 * defaults, so a hand-edited URL can never produce a request the server would not understand.
 */
export function parseCatalogQuery(params: Params): CatalogFilter {
  const category = first(params['category']).trim();
  const sort = first(params['sort']);
  return {
    category: category || DEFAULT_CATALOG_FILTER.category,
    q: first(params['q']).trim().slice(0, MAX_QUERY_LENGTH),
    sort: sort === 'title' ? 'title' : DEFAULT_CATALOG_FILTER.sort,
  };
}

/**
 * Query parameters for a filter. A default value is `null`, which the router drops from the URL, so
 * the unfiltered catalog stays at a clean `/catalog`.
 */
export function toCatalogQuery(filter: CatalogFilter): Params {
  return {
    category: filter.category === DEFAULT_CATALOG_FILTER.category ? null : filter.category,
    q: filter.q.trim() || null,
    sort: filter.sort === DEFAULT_CATALOG_FILTER.sort ? null : filter.sort,
  };
}

export function sameCatalogFilter(a: CatalogFilter, b: CatalogFilter): boolean {
  return a.category === b.category && a.q === b.q && a.sort === b.sort;
}
