// e2e/helpers/admin-ui.ts
//
// Driving the admin through its sign-in screen. The code goes in through the form because that is where
// it is supposed to enter; specs that only need "already signed in" use `signedInWith` instead.

import { expect, type Page } from '@playwright/test';

const SESSION_KEY = 'adminToken';

/** Signs in through `/admin/login` with `code` and waits for the admin frame. Safe when already signed in. */
export async function signInThroughForm(page: Page, code: string): Promise<void> {
  await page.goto('/admin/login');

  const codeField = page.locator('#access-code');
  const frame = page.locator('.sidebar');

  // Wait for the app to render *something* before deciding which state it is in: probing the field straight
  // after goto() races Angular's first paint. A reused context that is already signed in is redirected
  // past the form.
  await expect(codeField.or(frame).first()).toBeVisible();

  if (await codeField.isVisible()) {
    await codeField.fill(code);
    await page.getByRole('button', { name: 'Увійти' }).click();
  }
  await expect(frame).toBeVisible();
}

/** Puts `code` in the session before the app boots, as a completed sign-in would have. */
export async function signedInWith(page: Page, code: string): Promise<void> {
  await page.addInitScript(([key, value]) => sessionStorage.setItem(key, value), [SESSION_KEY, code]);
}

/** Navigates in the SPA to a sidebar item by its label. */
export async function openSection(page: Page, label: string): Promise<void> {
  await page.locator('.sidebar').getByRole('link', { name: label }).click();
}
