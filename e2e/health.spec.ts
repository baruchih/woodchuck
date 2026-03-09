import { test, expect } from '@playwright/test';

test.describe('Health & Navigation', () => {
  test('API health check returns ok', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('ok');
  });

  test('home page loads and shows title', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('text=Woodchuck')).toBeVisible();
  });

  test('settings page loads', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.locator('text=Settings')).toBeVisible();
    await expect(page.locator('text=Maintainer')).toBeVisible();
    await expect(page.locator('text=Project Visibility')).toBeVisible();
  });

  test('navigate to settings via gear icon', async ({ page }) => {
    await page.goto('/');
    await page.locator('button[aria-label="Settings"]').click();
    await expect(page).toHaveURL('/settings');
    await expect(page.locator('text=Settings')).toBeVisible();
  });

  test('navigate back from settings', async ({ page }) => {
    await page.goto('/settings');
    // Back button is the first button in the header
    await page.locator('button[aria-label="Back"]').or(page.locator('header button').first()).click();
    await expect(page).toHaveURL('/');
  });
});
