import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';

// Every component under test can call `useTranslation()` without each test file wiring up
// i18next itself — same reason `main.tsx` imports this before the first render.
import './i18n/config';

// With `globals: false` (see vite.config.ts), Testing Library's automatic
// afterEach cleanup isn't registered implicitly, so it's wired up explicitly.
afterEach(() => {
  cleanup();
});
