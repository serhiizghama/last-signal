import 'i18next';

import type { defaultNS, resources } from './config';

// i18next's TS module augmentation (https://www.i18next.com/overview/typescript): typing
// `CustomTypeOptions` against our actual RU resource shape turns every `t()` call site into
// a compile-time check — a typo'd or removed key is a build failure, not a silent fallback
// to the raw key string at runtime.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: typeof defaultNS;
    resources: (typeof resources)['ru'];
    // Missing keys must return `string` (the key itself), never `null` — matches
    // `returnNull: false` in config.ts and keeps `t()`'s return type usable as plain text.
    returnNull: false;
  }
}
