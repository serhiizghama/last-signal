/** Vite's default dev-server origin — the web app in local development. */
export const DEFAULT_CORS_ORIGIN = 'http://localhost:5173';

/**
 * Parses the `CORS_ORIGINS` env var (comma-separated list of allowed origins) into the
 * value passed to `enableCors({ origin })`.
 *
 * Unset, blank, or all-blank input falls back to the dev origin, so local `pnpm dev` needs
 * no `.env` entry; in production this is set to the Caddy-served origin. A wildcard `*` is
 * deliberately NOT supported: the session cookie is credentialed (`credentials: true`), and
 * browsers reject a wildcard `Access-Control-Allow-Origin` on credentialed requests — it
 * would look permissive and break every login instead.
 */
export function parseCorsOrigins(raw: string | undefined): string[] {
  const origins = (raw ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  const unique = [...new Set(origins)];

  return unique.length > 0 ? unique : [DEFAULT_CORS_ORIGIN];
}
