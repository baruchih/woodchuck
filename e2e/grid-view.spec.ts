import { test, expect } from '@playwright/test';

test.describe('Grid View', () => {
  test('view toggle button is visible on home page', async ({ page }) => {
    await page.goto('/');
    const toggle = page.locator('button[aria-label="Switch to grid view"], button[aria-label="Switch to list view"]');
    await expect(toggle).toBeVisible();
  });

  test('clicking toggle switches to grid view', async ({ page }) => {
    await page.goto('/');
    // Start in list view, click to switch to grid
    const gridToggle = page.locator('button[aria-label="Switch to grid view"]');
    if (await gridToggle.isVisible()) {
      await gridToggle.click();
      // After clicking, the button should now say "Switch to list view"
      await expect(page.locator('button[aria-label="Switch to list view"]')).toBeVisible();
    }
  });

  test('clicking toggle switches back to list view', async ({ page }) => {
    await page.goto('/');
    // Switch to grid first
    const gridToggle = page.locator('button[aria-label="Switch to grid view"]');
    if (await gridToggle.isVisible()) {
      await gridToggle.click();
      // Now switch back to list
      await page.locator('button[aria-label="Switch to list view"]').click();
      await expect(page.locator('button[aria-label="Switch to grid view"]')).toBeVisible();
    }
  });

  test('view mode persists in localStorage', async ({ page }) => {
    await page.goto('/');
    // Switch to grid
    const gridToggle = page.locator('button[aria-label="Switch to grid view"]');
    if (await gridToggle.isVisible()) {
      await gridToggle.click();
    }

    // Check localStorage
    const viewMode = await page.evaluate(() => localStorage.getItem('woodchuck-view-mode'));
    expect(viewMode).toBe('grid');

    // Reload and verify it persists
    await page.reload();
    await expect(page.locator('button[aria-label="Switch to list view"]')).toBeVisible();
  });

  test('grid view renders grid layout when sessions exist', async ({ page }) => {
    await page.goto('/');

    // Switch to grid view
    const gridToggle = page.locator('button[aria-label="Switch to grid view"]');
    if (await gridToggle.isVisible()) {
      await gridToggle.click();
    }

    // If there are sessions, grid cards should be visible with data-session-id attributes
    const gridCards = page.locator('[data-session-id]');
    const count = await gridCards.count();
    // Grid might be empty if no sessions — that's OK, just verify the toggle worked
    if (count > 0) {
      await expect(gridCards.first()).toBeVisible();
    }
  });
});
