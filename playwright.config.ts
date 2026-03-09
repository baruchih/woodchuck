import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:1212',
    headless: true,
    viewport: { width: 390, height: 844 }, // iPhone-ish
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
