// The server's own version, exposed by `GET /api/health`.
//
// Deliberately a literal rather than `process.env.npm_package_version`: that variable is
// only set when the process is started through a package manager script, so under pm2's
// `node dist/main.js` it is undefined and the reported version silently degrades to
// '0.0.0'. `version.spec.ts` asserts this constant matches `package.json`, so the two
// cannot drift. Mirrors `GAME_CORE_VERSION` in `game-core`.
export const SERVER_VERSION = '0.0.0';
