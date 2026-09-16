/**
 * Produces the exact numbers and query plans that go in the README's
 * "before/after the index" section — run this yourself to reproduce
 * them rather than take the README's word for it.
 *
 * Uses its own throwaway database file (bench.db), seeded fresh, so
 * this never touches whatever database the running server is using.
 *
 * Run with: node bench.js
 */

const fs = require('fs');
const path = require('path');

const BENCH_DB_PATH = path.join(__dirname, 'data', 'bench.db');
process.env.DB_PATH = BENCH_DB_PATH; // must be set before requiring ./db

const { openDatabase } = require('./db');
const { seed } = require('./seed');
const { PERF_INDEX_SQL } = require('./perf-index');

const QUERY = `
  SELECT b.title, l.due_at
  FROM loans l
  JOIN copies c ON c.id = l.copy_id
  JOIN books b ON b.id = c.book_id
  WHERE l.member_id = ? AND l.returned_at IS NULL
  ORDER BY l.borrowed_at DESC
`;

const RUNS = 50;

function timeQuery(db, memberId) {
  const stmt = db.prepare(QUERY);
  const timings = [];
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    stmt.all(memberId);
    timings.push(performance.now() - start);
  }
  timings.sort((a, b) => a - b);
  return {
    min: timings[0],
    median: timings[Math.floor(timings.length / 2)],
    max: timings[timings.length - 1],
  };
}

function formatPlan(rows) {
  return rows.map((r) => r.detail).join('\n');
}

function findMemberWithActiveLoans(db) {
  const row = db.prepare(`
    SELECT member_id, COUNT(*) AS n
    FROM loans
    WHERE returned_at IS NULL
    GROUP BY member_id
    ORDER BY n DESC
    LIMIT 1
  `).get();
  return row;
}

function main() {
  // Start clean so re-running this gives a fair, repeatable measurement.
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(BENCH_DB_PATH + suffix, { force: true });
  }

  console.log('Seeding a fresh benchmark database (this takes a few seconds)...\n');
  const db = openDatabase(BENCH_DB_PATH, { applyPerfIndex: false });
  const counts = seed(db);

  const target = findMemberWithActiveLoans(db);
  console.log(`Measuring against member_id=${target.member_id}, who has ${target.n} books currently out.`);
  console.log(`Database: ${counts.loanCount} loans, ${counts.copyCount} copies, ${counts.bookCount} books, ${counts.memberCount} members.\n`);

  console.log('=== BEFORE the index ===');
  const planBefore = db.prepare('EXPLAIN QUERY PLAN ' + QUERY).all(target.member_id);
  console.log(formatPlan(planBefore));
  const timingBefore = timeQuery(db, target.member_id);
  console.log(`min ${timingBefore.min.toFixed(2)}ms · median ${timingBefore.median.toFixed(2)}ms · max ${timingBefore.max.toFixed(2)}ms\n`);

  console.log(`Applying the index:\n${PERF_INDEX_SQL.trim()}\n`);
  db.exec(PERF_INDEX_SQL);
  db.exec('ANALYZE'); // let SQLite's planner know the index's statistics before re-checking the plan

  console.log('=== AFTER the index ===');
  const planAfter = db.prepare('EXPLAIN QUERY PLAN ' + QUERY).all(target.member_id);
  console.log(formatPlan(planAfter));
  const timingAfter = timeQuery(db, target.member_id);
  console.log(`min ${timingAfter.min.toFixed(2)}ms · median ${timingAfter.median.toFixed(2)}ms · max ${timingAfter.max.toFixed(2)}ms\n`);

  db.close();
}

main();
