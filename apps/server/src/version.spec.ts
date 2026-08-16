import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SERVER_VERSION } from './version';

// Reads the real manifest rather than hardcoding the expected string: the point of this test
// is to catch `package.json` and `version.ts` drifting apart when the version is bumped,
// which a hardcoded expectation would not do.
//
// `process.cwd()` rather than `import.meta.url`: this package compiles as CommonJS
// (`tsconfig.json` → `"module": "CommonJS"`), so `import.meta` is a type error. Vitest runs
// each workspace package from its own directory, and the `name` assertion below fails loudly
// if that ever stops being true instead of silently checking the wrong manifest.
const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
  name: string;
  version: string;
};

describe('SERVER_VERSION', () => {
  it('reads the server package manifest, not another one', () => {
    expect(manifest.name).toBe('@last-signal/server');
  });

  it('matches the version in package.json', () => {
    expect(SERVER_VERSION).toBe(manifest.version);
  });

  it('is a semver triple', () => {
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
