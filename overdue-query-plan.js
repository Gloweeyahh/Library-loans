/**
 * Captures the query plan and timing for a query that doesn't have
 * its own endpoint yet, but obviously should: "every currently
 * overdue loan, library-wide" — the report a librarian would ask for
 * first. Used to back up DATA_MODEL.md's answer to "which query would
 * fall apart first at ten times the data" with a real plan instead of
 * a guess.
 *
 * Run with: node overdue-query-plan.js
 */

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'overdue-check.db');
process.env.DB_PATH = DB_PATH;

const { openDatabase } = require('./db');
const { seed } = require('./seed');

const QUERY = `
  SELECT m.name, b.title, l.due_at
  FROM loans l
  JOIN copies c ON c.id = l.copy_id
  JOIN books b ON b.id = c.book_id
  JOIN members m ON m.id = l.member_id
  WHERE l.returned_at IS NULL AND l.due_at < ?
  ORDER BY l.due_at ASC
`;

const RUNS = 50;

function timeQuery(db, cutoff) {
  const stmt = db.prepare(QUERY);
  const timings = [];
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    stmt.all(cutoff);
    timings.push(performance.now() - start);
  }
  timings.sort((a, b) => a - b);
  return { min: timings[0], median: timings[Math.floor(timings.length / 2)], max: timings[timings.length - 1] };
}

function main() {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB_PATH + suffix, { force: true });

  console.log('Seeding a fresh database (this takes a few seconds)...\n');
  const db = openDatabase(DB_PATH);
  const counts = seed(db);

  const activeCount = db.prepare('SELECT COUNT(*) AS n FROM loans WHERE returned_at IS NULL').get().n;
  console.log(`Database: ${counts.loanCount} loans, ${activeCount} currently active.\n`);

  const cutoff = new Date().toISOString(); // "overdue as of right now"

  console.log('=== Query plan: every overdue loan, library-wide ===');
  const plan = db.prepare('EXPLAIN QUERY PLAN ' + QUERY).all(cutoff);
  console.log(plan.map((r) => r.detail).join('\n'));

  const timing = timeQuery(db, cutoff);
  console.log(`\nmin ${timing.min.toFixed(2)}ms · median ${timing.median.toFixed(2)}ms · max ${timing.max.toFixed(2)}ms`);
  console.log(`(scanning ${activeCount} active loans out of ${counts.loanCount} total)`);

  db.close();
}

main();
