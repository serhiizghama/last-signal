// Name of the httpOnly session cookie.
export const SESSION_COOKIE_NAME = 'lsSession';

// Session lifetime and matching cookie `maxAge`: 30 days — long enough that a casual player
// (§0 of the M1 design record: as few as 2 logins/day) never gets silently logged out
// mid-round (rounds run ~21 days), short enough that an abandoned browser session doesn't
// live forever. Revocation (logout, an admin deleting the session document) is immediate
// regardless of this TTL — see `Session`'s schema comment.
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Session id entropy: 32 random bytes (256 bits) from `node:crypto randomBytes`, hex-encoded.
export const SESSION_ID_BYTES = 32;

// Bounded retry count for the "random guest display name collided" loop in
// `AuthService.loginAsGuest` — collisions are astronomically unlikely (see that method's
// comment); this bound exists only so a pathological run fails loudly instead of looping
// forever.
export const MAX_GUEST_NAME_ATTEMPTS = 3;
