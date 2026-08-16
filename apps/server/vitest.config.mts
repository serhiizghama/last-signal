import { defineConfig } from 'vitest/config';

// The server follows NestJS's `.spec.ts` naming convention, unlike the other
// packages, which use `.test.ts`. The `.mts` extension forces ESM parsing —
// `apps/server` has no `"type": "module"`, so a plain `.ts` config would be
// loaded as CommonJS and warn.
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    globals: false,
    // Integration specs spin up a real MongoMemoryReplSet; the first run on
    // a machine downloads the mongod binary, which can take a while.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
