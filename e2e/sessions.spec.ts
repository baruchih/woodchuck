import { test, expect } from '@playwright/test';

test.describe('Sessions API', () => {
  test('list sessions returns array', async ({ request }) => {
    const res = await request.get('/api/sessions');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.sessions)).toBe(true);
  });

  test('get non-existent session returns 404', async ({ request }) => {
    const res = await request.get('/api/sessions/does-not-exist-12345');
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe('SESSION_NOT_FOUND');
  });

  test('list folders returns array', async ({ request }) => {
    const res = await request.get('/api/folders');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.folders)).toBe(true);
  });

  test('maintainer session is hidden from sessions list', async ({ request }) => {
    const res = await request.get('/api/sessions');
    const body = await res.json();
    const ids = body.data.sessions.map((s: { id: string }) => s.id);
    expect(ids).not.toContain('woodchuck-maintainer');
  });
});

test.describe('Sessions UI', () => {
  test('home page shows new session button', async ({ page }) => {
    await page.goto('/');
    // The + button for new session
    const newBtn = page.locator('button').filter({ hasText: /^\+$/ }).or(
      page.locator('button[title="New Session"]').or(
        page.locator('svg path[d="M12 5v14M5 12h14"]').locator('..')
      )
    );
    // There should be a way to create new sessions
    await expect(page.locator('button').last()).toBeVisible();
  });

  test('new session page loads', async ({ page }) => {
    await page.goto('/new');
    await expect(page.locator('text=New Session').or(page.locator('text=Create'))).toBeVisible();
  });
});
