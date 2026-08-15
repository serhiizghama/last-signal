import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';

// With `globals: false` (see vite.config.ts), Testing Library's automatic
// afterEach cleanup isn't registered implicitly, so it's wired up explicitly.
afterEach(() => {
  cleanup();
});
