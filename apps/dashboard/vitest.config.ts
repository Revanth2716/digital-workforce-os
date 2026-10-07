/**
 * Dashboard test configuration (M5-B).
 *
 * Deliberately lightweight: `node` environment, no jsdom, no
 * React Testing Library. The dashboard's correctness lives in its
 * pure logic (API client, formatters, mappers, hook state machine),
 * all of which is testable without a DOM. Adding a browser
 * simulation stack would cost more than it would prove.
 */

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    testTimeout: 10_000,
  },
});