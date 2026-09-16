/**
 * The index bench.js and the README's "before/after" measurement are
 * about. Applied unconditionally in db.js (the real, deployed database
 * should obviously be fast) — kept in its own file so bench.js can
 * apply this exact same statement at a controlled point in time,
 * rather than the two places drifting out of sync with each other.
 *
 * Column order matters here, and is chosen for this query specifically
 * (see server.js, the current-loans endpoint):
 *
 *   WHERE member_id = ? AND returned_at IS NULL
 *   ORDER BY borrowed_at DESC
 *
 * member_id first (the equality filter with the highest selectivity),
 * then returned_at (also an equality filter, narrows further), then
 * borrowed_at DESC last, so SQLite can walk the index in the exact
 * order the query needs and skip a separate sort step entirely. See
 * README for the actual query plan this produces.
 */

const PERF_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_loans_member_active_recent
  ON loans(member_id, returned_at, borrowed_at DESC);
`;

module.exports = { PERF_INDEX_SQL };
