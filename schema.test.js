/**
 * Tests against the schema directly — no HTTP layer at all — because
 * the double-lending guarantee this project makes lives in the
 * database schema, not in server.js. If these pass, the guarantee
 * holds no matter what the application code above it does.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'data', 'test-schema.db');
process.env.DB_PATH = TEST_DB_PATH;
const { openDatabase } = require('./db');

let db;

test.before(() => {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(TEST_DB_PATH + suffix, { force: true });
  db = openDatabase(TEST_DB_PATH);
  db.exec("INSERT INTO books (id, title, author, published_year) VALUES (1, 'Test Book', 'Test Author', 2000)");
  db.exec('INSERT INTO copies (id, book_id, copy_number) VALUES (1, 1, 1)');
  db.exec("INSERT INTO members (id, name, email, joined_at) VALUES (1, 'Alice', 'alice@example.com', '2024-01-01')");
  db.exec("INSERT INTO members (id, name, email, joined_at) VALUES (2, 'Bob', 'bob@example.com', '2024-01-01')");
});

test.after(() => db.close());

test('a copy can be loaned when it has no active loan', () => {
  db.exec("INSERT INTO loans (copy_id, member_id, borrowed_at, due_at, returned_at) VALUES (1, 1, '2024-01-01', '2024-01-21', NULL)");
  const active = db.prepare('SELECT * FROM loans WHERE copy_id = 1 AND returned_at IS NULL').all();
  assert.equal(active.length, 1);
});

test('a second active loan on the same copy is rejected by the database', () => {
  assert.throws(
    () => db.exec("INSERT INTO loans (copy_id, member_id, borrowed_at, due_at, returned_at) VALUES (1, 2, '2024-01-05', '2024-01-25', NULL)"),
    /UNIQUE constraint failed/
  );
});

test('after the active loan is returned, the copy can be loaned again', () => {
  db.exec("UPDATE loans SET returned_at = '2024-01-15' WHERE copy_id = 1 AND returned_at IS NULL");
  db.exec("INSERT INTO loans (copy_id, member_id, borrowed_at, due_at, returned_at) VALUES (1, 2, '2024-01-16', '2024-02-05', NULL)");
  const active = db.prepare('SELECT * FROM loans WHERE copy_id = 1 AND returned_at IS NULL').all();
  assert.equal(active.length, 1);
  assert.equal(active[0].member_id, 2);
});

test('a loan cannot reference a copy that does not exist', () => {
  assert.throws(
    () => db.exec("INSERT INTO loans (copy_id, member_id, borrowed_at, due_at, returned_at) VALUES (999, 1, '2024-01-01', '2024-01-21', NULL)"),
    /FOREIGN KEY constraint failed/
  );
});

test('a loan cannot reference a member that does not exist', () => {
  // A fresh copy with no active loan, so this fails on the *member*
  // foreign key specifically — copy 1 already has an active loan at
  // this point in the suite, which would fail first for a different
  // reason (the UNIQUE constraint) and mask what this test is for.
  db.exec('INSERT INTO copies (id, book_id, copy_number) VALUES (3, 1, 3)');
  assert.throws(
    () => db.exec("INSERT INTO loans (copy_id, member_id, borrowed_at, due_at, returned_at) VALUES (3, 999, '2024-01-01', '2024-01-21', NULL)"),
    /FOREIGN KEY constraint failed/
  );
});

test('two DIFFERENT copies can both be on active loan at once (the constraint is per-copy, not global)', () => {
  db.exec('INSERT INTO copies (id, book_id, copy_number) VALUES (2, 1, 2)');
  db.exec("INSERT INTO loans (copy_id, member_id, borrowed_at, due_at, returned_at) VALUES (2, 1, '2024-01-01', '2024-01-21', NULL)");
  const active = db.prepare('SELECT * FROM loans WHERE returned_at IS NULL').all();
  assert.ok(active.length >= 2);
});
