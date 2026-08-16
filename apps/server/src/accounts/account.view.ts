import type { AccountDocument, Faction, Side } from '../schemas/account.schema';

// Wire shape for an account, returned by `POST /api/auth/guest`, `GET /api/auth/me`, and
// `POST /api/accounts/register` — one shape, one place, so the three endpoints never drift.
// Deliberately excludes `tgId` (cross-round identity key, no client use case yet) and
// `settings` (opaque bag, not yet part of any contract).
export interface AccountView {
  id: string;
  name: string;
  isGuest: boolean;
  faction?: Faction;
  side?: Side;
  contribution: number;
  medals: string[];
  createdAt: number;
}

// Pure reshape of a persisted account document into the wire view — mirrors
// `buildSettlementStateView`'s role for settlements. Plain field reads (not a spread): see
// `toPlainResources`'s comment in `settlements.view.ts` for why spreading a Mongoose
// document is unsafe.
export function buildAccountView(doc: AccountDocument): AccountView {
  return {
    id: String(doc._id),
    name: doc.name,
    isGuest: doc.isGuest,
    faction: doc.faction,
    side: doc.side,
    contribution: doc.contribution,
    medals: [...doc.medals],
    createdAt: doc.createdAt,
  };
}
