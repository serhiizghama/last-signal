// MongoDB's duplicate-key error code — shared by every write path that relies on a unique
// index as its ultimate race-safety guard (settlement `{x,y}` placement, account `name`
// uniqueness, guest display-name collisions) instead of a racy pre-check-then-write.
const DUPLICATE_KEY_ERROR_CODE = 11000;

// `true` when `error` is a MongoDB duplicate-key error (E11000) — the shape the driver
// throws is `{ code: 11000, ... }`, not an `Error` subclass, so this is a structural check
// rather than an `instanceof`.
export function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === DUPLICATE_KEY_ERROR_CODE
  );
}
