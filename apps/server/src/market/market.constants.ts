// `GameEvent.type` this feature schedules and handles (§14, M3d.2): an open offer's TTL
// running out. Mirrors `MOVEMENT_ARRIVE_EVENT_TYPE`'s own naming convention
// (`movements.constants.ts`).
export const TRADE_OFFER_EXPIRE_EVENT_TYPE = 'tradeOfferExpire';

// `GameEvent.type` for the world exchange's own scheduled completion (§14, M3d.4) — a
// settlement's merchants come home `config.market.exchangeTripMs` after `startExchange`,
// crediting the converted output. Same naming convention as `TRADE_OFFER_EXPIRE_EVENT_TYPE`
// above.
export const MARKET_EXCHANGE_EVENT_TYPE = 'marketExchange';

// Bounded retry count for the version-guard command pattern (concurrency playbook), mirrors
// `MAX_COMMAND_ATTEMPTS` in `settlements.constants.ts`/`movements.constants.ts` — kept as its
// own constant (not imported cross-module) so this feature's retry bound can move
// independently, the same reason those two keep their own copies rather than sharing one.
export const MAX_COMMAND_ATTEMPTS = 5;
