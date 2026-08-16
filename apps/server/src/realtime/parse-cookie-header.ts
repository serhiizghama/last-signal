// Socket.io's handshake is a raw HTTP request handled by the engine.io layer — it never
// passes through Express's `cookie-parser` middleware (that's wired in `AppModule.configure()`
// for the REST routes only), so `RealtimeGateway` has to read the `Cookie` header itself.
// A small, dependency-free parse rather than reaching for the `cookie` package (an undeclared
// transitive dependency of `cookie-parser` here, not something this package.json owns): the
// session cookie's value is a fixed-shape hex token (`SessionService.create`), so this doesn't
// need to handle anything more exotic than `name=value` pairs.
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) {
    return cookies;
  }

  for (const pair of header.split(';')) {
    const separatorIndex = pair.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }
    const key = pair.slice(0, separatorIndex).trim();
    const rawValue = pair.slice(separatorIndex + 1).trim();
    if (!key) {
      continue;
    }
    try {
      cookies[key] = decodeURIComponent(rawValue);
    } catch {
      // A malformed percent-encoding is still a value worth having as-is rather than
      // dropping the cookie entirely — `AuthService.resolveAccountForSession` will simply
      // fail to resolve it to a session, same as any other unknown session id.
      cookies[key] = rawValue;
    }
  }

  return cookies;
}
