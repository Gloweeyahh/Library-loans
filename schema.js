/**
 * Base schema. Deliberately does NOT include the performance index on
 * loans(member_id, ...) — that one is added separately (see
 * perf-index.js) so bench.js can measure the list endpoint's query
 * plan both without it and with it, for the README.
 *
 * The one index that IS always here, unconditionally, is
 * idx_one_active_loan_per_copy — that's not a performance index, it's
 * the actual mechanism that makes double-lending impossible. See
 * README, "How double-lending is prevented."
 */

const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS books (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  published_year INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS copies (
  id INTEGER PRIMARY KEY,
  book_id INTEGER NOT NULL REFERENCES books(id),
  copy_number INTEGER NOT NULL,
  UNIQUE (book_id, copy_number)
);

CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  joined_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS loans (
  id INTEGER PRIMARY KEY,
  copy_id INTEGER NOT NULL REFERENCES copies(id),
  member_id INTEGER NOT NULL REFERENCES members(id),
  borrowed_at TEXT NOT NULL,
  due_at TEXT NOT NULL,
  returned_at TEXT
);

-- A copy can have many loans over its lifetime, but at most one with
-- returned_at IS NULL at any moment: this partial unique index makes a
-- second concurrent loan on the same copy a constraint violation, not
-- a possibility the application has to remember to check for.
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_loan_per_copy
  ON loans(copy_id)
  WHERE returned_at IS NULL;
`;

module.exports = { SCHEMA_SQL };
