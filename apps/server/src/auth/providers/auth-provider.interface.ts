// A verified identity handed back by an `AuthProvider`, scoped to that provider — never
// persisted directly as `Account.tgId`; it's `AuthService`'s job to decide how a given
// `ExternalIdentity` resolves to (or creates) an `Account`.
export interface ExternalIdentity {
  provider: 'guest' | 'telegram';
  externalId: string;
  displayName?: string;
}

// The seam M7's Telegram Login swaps in behind, with zero change to any call site (§13 of
// the M1 design record: "Telegram Login implemented behind the same service interface").
// `credentials` is deliberately `unknown` — each provider defines its own shape (guest:
// nothing meaningful; Telegram: the Login Widget's payload, see
// `TelegramAuthProvider`'s comment) and validates it internally.
export interface AuthProvider {
  verify(credentials: unknown): Promise<ExternalIdentity>;
}
