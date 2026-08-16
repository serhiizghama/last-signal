// DI tokens for the pluggable `AuthProvider` implementations (see
// `providers/auth-provider.interface.ts`) — symbols, not the concrete classes, so
// `AuthService` depends on the interface rather than a specific provider (the same
// rationale as `GAME_CONFIG` in `game-config.tokens.ts`: interfaces cannot be DI tokens,
// and this is the seam a later swap replaces `useClass` behind, with zero call-site change).
export const GUEST_AUTH_PROVIDER = Symbol('GUEST_AUTH_PROVIDER');
export const TELEGRAM_AUTH_PROVIDER = Symbol('TELEGRAM_AUTH_PROVIDER');
