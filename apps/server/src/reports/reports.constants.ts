// `GET /api/reports` pagination bounds. Default is generous enough that a casual player's
// inbox fits on one page almost always; the cap exists only so a client can't force an
// unbounded scan/response by asking for an absurd `limit`.
export const DEFAULT_REPORTS_LIMIT = 20;
export const MAX_REPORTS_LIMIT = 100;
