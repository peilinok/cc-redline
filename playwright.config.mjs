import { defineConfig } from '@playwright/test';

// E2E for the review UI. Drives the system Chrome (channel: 'chrome') so no
// browser download is needed — dev machines and GitHub runners ship one.
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    channel: 'chrome',
    headless: true,
    viewport: { width: 1280, height: 800 },
  },
});
