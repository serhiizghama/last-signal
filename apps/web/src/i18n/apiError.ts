import type { i18n as I18nInstance } from 'i18next';

import { ApiError } from '../api/client';
import errorsRu from './locales/ru/errors.json';

const ERRORS_NAMESPACE_PREFIX = 'errors.';

/**
 * The server's error keys already spell out the `errors` namespace as their first path
 * segment (e.g. `errors.account.nameTaken` — see `apps/server`'s `errorBody` helper). i18next
 * namespaces are a separate concept from key paths, so translating that string means
 * stripping the `errors.` prefix and looking the remainder up inside the `errors` namespace.
 */
export function toErrorsNamespaceKey(serverKey: string): string {
  return serverKey.startsWith(ERRORS_NAMESPACE_PREFIX)
    ? serverKey.slice(ERRORS_NAMESPACE_PREFIX.length)
    : serverKey;
}

/** All dot-paths whose leaf is a string, e.g. `'account.nameTaken'` for `{ account: { nameTaken: '...' } }`. */
type DotPaths<T> = T extends string
  ? never
  : { [K in keyof T & string]: T[K] extends string ? K : `${K}.${DotPaths<T[K]>}` }[keyof T &
      string];

/** Every key our RU `errors` bundle actually defines — derived from the same JSON `t()` is typed against. */
type KnownErrorKey = DotPaths<typeof errorsRu>;

function flattenKeys(source: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(source).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'string' ? [path] : flattenKeys(value as Record<string, unknown>, path);
  });
}

// Built once, from the same JSON the `KnownErrorKey` type is derived from, so the runtime
// guard below can never drift out of sync with what `t()` is statically typed to accept.
const KNOWN_ERROR_KEYS = new Set<string>(flattenKeys(errorsRu));

function isKnownErrorKey(key: string): key is KnownErrorKey {
  return KNOWN_ERROR_KEYS.has(key);
}

/**
 * Translates any thrown value into Russian text, always through i18next — never the raw
 * server key, never an untranslated exception message. A key our RU bundle doesn't define
 * (server got ahead of the client, or a genuinely unknown failure) falls back to
 * `errors:generic` rather than leaking the key itself to the player.
 */
export function translateApiError(i18n: I18nInstance, error: unknown): string {
  if (!(error instanceof ApiError)) {
    return i18n.t('generic', { ns: 'errors' });
  }

  const key = toErrorsNamespaceKey(error.key);
  if (!isKnownErrorKey(key)) {
    return i18n.t('generic', { ns: 'errors' });
  }
  return i18n.t(key, { ns: 'errors', ...error.params });
}
