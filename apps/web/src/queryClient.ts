import { QueryClient } from '@tanstack/react-query';

import { ApiError } from './api/client';

// A 401 from `/api/auth/me` is an expected, meaningful state (no session yet) that
// `Onboarding` branches on directly — retrying it would just delay the welcome screen.
// Other failures (network blips, 5xx) get TanStack Query's default retry behaviour.
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status === 401) {
    return false;
  }
  return failureCount < 2;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: shouldRetry,
    },
  },
});
