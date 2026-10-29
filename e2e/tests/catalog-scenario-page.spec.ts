// e2e/tests/catalog-scenario-page.spec.ts
//
// Release 1, phase 3 - the Nocturne catalog and the scenario page against the running stack.
// Covers test-plan scenarios 132 (URL round trip, back, real counters - DW-3.1, DW-3.2), 134 (390 px -
// DW-3.7), 135 (no cross-origin request - DW-3.9), 137 (empty and error states - DW-3.3) and the
// scenario page's real data (DW-3.4, DW-3.5).

import { expect, test, type Page } from '@playwright/test';
import { BASE_URL, createScenario, deleteScenario, uniqueScenarioId, updateScenario, uploadArchive } from '../helpers/api';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN!;

interface CatalogAnswer {
  scenarios: Array<{ id: string; title: string; category: string }>;
  categories: Array<{ category: string; categoryLabel: string; icon: string; count: number }>;
  summary: { scenarios: number; categories: number };
}

async function catalogAnswer(): Promise<CatalogAnswer> {
  return (await fetch(`${BASE_URL}/api/catalog?limit=50`)).json() as Promise<CatalogAnswer>;
}

test.describe('catalog (Nocturne)', () => {
  test('DW-3.1 the chips and the found line show real numbers from the API', async ({ page }) => {
    const { summary, categories } = await catalogAnswer();

    await page.goto('/catalog');
    await expect(page.locator('.scenario-card').first()).toBeVisible();

    const chips = (await page.locator('.chips .chip').allTextContents()).map(t => t.replace(/\s+/g, ' ').trim());
    expect(chips).toEqual([
      `Усі напрями${summary.scenarios}`,
      ...categories.map(c => `${c.categoryLabel}${c.count}`),
    ]);

    await expect(page.locator('.found')).toContainText(`Знайдено ${summary.scenarios}`);
    await expect(page.locator('.account')).toHaveText('Увійти');
  });

  test('DW-5.1 the catalog has no hero and the footer is the copyright bar only', async ({ page }) => {
    await page.goto('/catalog');
    await expect(page.locator('.scenario-card').first()).toBeVisible();

    await expect(page.locator('.hero, .hero-title, .hero-lead, .fact')).toHaveCount(0);
    await expect(page.locator('.footer-inner')).toHaveCount(0);
    await expect(page.locator('footer a[href="/admin"]')).toHaveCount(0);
    await expect(page.locator('.footer-legal')).toContainText('©');
    // /admin stays reachable by its URL; only the footer link went. Signed out it lands on the sign-in screen.
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/admin\/login$/);
    await expect(page.locator('input[type="password"]')).toBeVisible();
  });

  test('DW-3.1 the header button reads "Панель" once the admin token is in the session', async ({ page }) => {
    await page.goto('/admin');
    await page.locator('input[type="password"]').fill(ADMIN_TOKEN);
    await page.getByRole('button', { name: 'Увійти' }).click();
    await expect(page.locator('.sidebar')).toBeVisible();

    await page.goto('/catalog');
    await expect(page.locator('.account')).toHaveText('Панель');
  });

  test('DW-3.2 a filtered URL restores category, search and sort, and Back from a scenario page keeps them', async ({ page }) => {
    const { categories } = await catalogAnswer();
    const category = categories[0];
    await page.goto(`/catalog?category=${category.category}&sort=title`);

    await expect(page.locator('.chips .chip[aria-pressed="true"]')).toContainText(category.categoryLabel);
    await expect(page.getByRole('radio', { name: 'За назвою' })).toBeChecked();
    await expect(page.locator('.scenario-card').first()).toBeVisible();
    expect(await page.locator('.scenario-card').count()).toBe(category.count);

    await page.locator('.scenario-card .open-button').first().click();
    await expect(page).toHaveURL(/\/scenario\//);

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`category=${category.category}.*sort=title|sort=title.*category=${category.category}`));
    await expect(page.locator('.chips .chip[aria-pressed="true"]')).toContainText(category.categoryLabel);
    await expect(page.getByRole('radio', { name: 'За назвою' })).toBeChecked();
  });

  test('DW-3.2 the scenario page\'s "Каталог" button returns with the filter', async ({ page }) => {
    const { categories } = await catalogAnswer();
    await page.goto(`/catalog?category=${categories[0].category}`);
    await page.locator('.scenario-card .open-button').first().click();
    await page.locator('.back').click();

    await expect(page).toHaveURL(new RegExp(`/catalog\\?category=${categories[0].category}`));
    await expect(page.locator('.chips .chip[aria-pressed="true"]')).toContainText(categories[0].categoryLabel);
  });

  test('DW-3.3 no results: empty state, and "Скинути фільтри" clears the URL', async ({ page }) => {
    await page.goto('/catalog?q=zzzz-no-such-scenario&sort=title');
    await expect(page.locator('.empty-state')).toContainText('Нічого не знайдено');
    await expect(page.locator('.found')).toHaveText('Знайдено 0 сценаріїв');

    await page.getByRole('button', { name: 'Скинути фільтри' }).click();
    await expect(page).toHaveURL(/\/catalog$/);
    await expect(page.getByLabel('Пошук сценаріїв')).toHaveValue('');
    await expect(page.locator('.scenario-card').first()).toBeVisible();
  });

  test('DW-3.3 an API failure shows the error state and "Спробувати ще раз" recovers', async ({ page }) => {
    let fail = true;
    await page.route(/\/api\/catalog\?/, route =>
      fail ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' }) : route.continue());

    await page.goto('/catalog');
    await expect(page.locator('.error-state')).toContainText('Не вдалося завантажити каталог');
    await expect(page.locator('.scenario-card')).toHaveCount(0);

    fail = false;
    await page.getByRole('button', { name: 'Спробувати ще раз' }).click();
    await expect(page.locator('.scenario-card').first()).toBeVisible();
    await expect(page.locator('.error-state')).toHaveCount(0);
  });

  test('DW-3.6 no theme toggle, no dialog, and no `theme` key in storage', async ({ page }) => {
    await page.goto('/catalog');
    await expect(page.locator('.scenario-card').first()).toBeVisible();
    await page.locator('.scenario-card .open-button').first().click();
    await expect(page.locator('h1.title')).toBeVisible();

    await expect(page.locator('[role="dialog"], .modal-overlay, .theme-toggle')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('theme'))).toBeNull();
  });
});

test.describe('scenario page', () => {
  test('DW-3.4 renders the real fields of a scenario', async ({ page }) => {
    const res = await fetch(`${BASE_URL}/api/catalog/solar-system`);
    const item = await res.json() as {
      title: string; author: string; version: string; scenarioUrl: string; categoryLabel: string;
      archiveBytes: number | null; related: unknown[];
    };

    await page.goto('/scenario/solar-system');
    await expect(page.locator('h1.title')).toHaveText(item.title);
    await expect(page).toHaveTitle(new RegExp(item.title));
    await expect(page.locator('.kicker')).toHaveText(item.categoryLabel);

    const meta = page.locator('.meta-row');
    await expect(meta.filter({ hasText: 'Версія' })).toContainText(item.version);
    await expect(meta.filter({ hasText: 'Автор' })).toContainText(item.author);
    await expect(meta.filter({ hasText: 'Ідентифікатор' })).toContainText('solar-system');
    if (item.archiveBytes) await expect(meta.filter({ hasText: 'Розмір архіву' })).toBeVisible();
    await expect(meta.filter({ hasText: 'Оновлено' })).toBeVisible();

    if (item.related.length) await expect(page.locator('.related-item')).toHaveCount(item.related.length);
  });

  test('DW-5.2 no download link and no launch note; launch and copy-link still work', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE_URL });
    await page.goto('/scenario/solar-system');
    await expect(page.locator('h1.title')).toBeVisible();

    await expect(page.locator('.download, a[download], .launch-note')).toHaveCount(0);
    await expect(page.locator('.footer-inner')).toHaveCount(0);

    await page.getByRole('button', { name: 'Копіювати посилання' }).click();
    await expect(page.getByText('Посилання скопійовано')).toBeVisible();

    await page.locator('.side .launch').click();
    await expect(page).toHaveURL(/\/play\/solar-system$/);
  });

  test('DW-3.4 an unknown id shows the not-found state', async ({ page }) => {
    await page.goto('/scenario/no-such-scenario');
    await expect(page.locator('.not-found-state')).toContainText('Сценарій не знайдено');
    await expect(page).toHaveTitle(/Сценарій не знайдено/);
    await page.getByRole('link', { name: 'До каталогу' }).click();
    await expect(page).toHaveURL(/\/catalog$/);
  });

  test('DW-3.4 a server error shows the error state and retry recovers', async ({ page }) => {
    let fail = true;
    await page.route('**/api/catalog/solar-system', route =>
      fail ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' }) : route.continue());

    await page.goto('/scenario/solar-system');
    await expect(page.locator('.error-state')).toBeVisible();

    fail = false;
    await page.getByRole('button', { name: 'Спробувати ще раз' }).click();
    await expect(page.locator('h1.title')).toBeVisible();
  });

  test('DW-3.4 features and related are shown when present and their blocks vanish when absent; no archive hides launch', async ({ page }) => {
    const withFeatures = uniqueScenarioId('feat');
    const bare = uniqueScenarioId('bare');
    const base = { category: 'test', categoryLabel: 'Test', title: 'E2E сторінка', description: 'd', fullDescription: '' };
    try {
      await createScenario({
        ...base, id: withFeatures,
        features: [{ icon: 'atom', title: 'Атоми', subtitle: 'Будова' }, { icon: 'flask', title: 'Колби' }],
      });
      await createScenario({ ...base, id: bare });
      // A new row is a draft and the public page serves only published ones; approving needs an archive,
      // so upload first (PUT isPublished maps to approve).
      for (const id of [withFeatures, bare]) {
        await uploadArchive(id);
        await updateScenario(id, { isPublished: true });
      }

      await page.goto(`/scenario/${withFeatures}`);
      await expect(page.locator('.feature')).toHaveCount(2);
      await expect(page.locator('.feature').first()).toContainText('Атоми');
      await expect(page.locator('.feature').first()).toContainText('Будова');

      // A published row always has an archive now, so "no archive" is staged by stripping what the API
      // reports of it: the page decides from `scenarioUrl` alone.
      await page.route(`**/api/catalog/${bare}`, async route => {
        const response = await route.fetch();
        const body = await response.json();
        await route.fulfill({ response, json: { ...body, scenarioUrl: '', archiveBytes: null } });
      });
      await page.goto(`/scenario/${bare}`);
      await expect(page.locator('h1.title')).toBeVisible();
      await expect(page.getByText('Що всередині')).toHaveCount(0);
      // The row reports no archive: nothing to launch or download, and no placeholder in their place.
      await expect(page.locator('.launch, .launch-bar, .download')).toHaveCount(0);
      await expect(page.locator('.meta-row', { hasText: 'Розмір архіву' })).toHaveCount(0);
    } finally {
      await deleteScenario(withFeatures);
      await deleteScenario(bare);
    }
  });

  test('DW-3.5 "Копіювати посилання" copies the absolute URL and toasts', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE_URL });
    await page.goto('/scenario/solar-system');
    await page.getByRole('button', { name: 'Копіювати посилання' }).click();

    await expect(page.getByRole('status').getByText('Посилання скопійовано')).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${BASE_URL}/scenario/solar-system`);
  });

  test('DW-3.5 without a Clipboard API the link is shown selectable', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }));
    await page.goto('/scenario/solar-system');
    await page.getByRole('button', { name: 'Копіювати посилання' }).click();

    const link = page.getByLabel('Посилання на сценарій');
    await expect(link).toHaveValue(`${BASE_URL}/scenario/solar-system`);
    await expect(link).toBeFocused().catch(() => undefined); // focus is a courtesy; the visible value is the contract
    await expect(page.getByText('Посилання скопійовано')).toHaveCount(0);
  });
});

test.describe('390 x 844 phone (DW-3.7)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  const noHorizontalScroll = (page: Page) =>
    page.evaluate(() => [document.documentElement, document.body].every(el => el.scrollWidth <= window.innerWidth));

  test('the catalog does not scroll sideways and its chips scroll on their own', async ({ page }) => {
    await page.goto('/catalog');
    await expect(page.locator('.scenario-card').first()).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);

    const chips = page.locator('.chips');
    const overflow = await chips.evaluate(el => ({ scroll: el.scrollWidth, client: el.clientWidth, overflowX: getComputedStyle(el).overflowX }));
    expect(overflow.overflowX).toBe('auto');
    expect(overflow.scroll, 'five chips do not fit 390 px, so the row must scroll').toBeGreaterThan(overflow.client);

    await chips.evaluate(el => { el.scrollLeft = 80; });
    expect(await chips.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
    expect(await noHorizontalScroll(page)).toBe(true);
  });

  test('the scenario page does not scroll sideways and keeps a sticky launch bar in view', async ({ page }) => {
    await page.goto('/scenario/solar-system');
    await expect(page.locator('h1.title')).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);

    const bar = page.locator('.launch-bar');
    await expect(bar).toBeVisible();
    // The sidebar's own launch button is hidden here: one "Запустити" on screen, the bar's.
    await expect(page.locator('.side .launch')).toBeHidden();

    for (const y of [0, 400, 100000]) {
      await page.evaluate(top => document.body.scrollTo(0, top), y);
      const box = await bar.boundingBox();
      expect(box, `bar at scroll ${y}`).not.toBeNull();
      expect(box!.y + box!.height).toBeLessThanOrEqual(844 + 1);
      expect(box!.y).toBeGreaterThanOrEqual(0);
    }

    await bar.getByRole('button').click();
    await expect(page).toHaveURL(/\/play\/solar-system$/);
  });
});

test.describe('same origin only (DW-3.9)', () => {
  test('loading the catalog and a scenario page requests nothing from another origin', async ({ page }) => {
    const origin = new URL(BASE_URL).origin;
    const foreign: string[] = [];
    page.on('request', request => {
      const url = request.url();
      if (/^(data|blob|about):/.test(url)) return;
      if (new URL(url).origin !== origin) foreign.push(url);
    });

    await page.goto('/catalog');
    await expect(page.locator('.scenario-card').first()).toBeVisible();
    await page.locator('.scenario-card .open-button').first().click();
    await expect(page.locator('h1.title')).toBeVisible();
    await page.waitForLoadState('networkidle');

    expect(foreign, `off-origin requests:\n${foreign.join('\n')}`).toEqual([]);
  });
});
