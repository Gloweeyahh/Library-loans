/**
 * Starts the real server (server.js, unmodified) on a random free
 * port, against its own isolated, minimally-seeded database, and
 * talks to it with real HTTP requests via Node's built-in fetch.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'data', 'test-server.db');
process.env.DB_PATH = TEST_DB_PATH;
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(TEST_DB_PATH + suffix, { force: true });

const { openDatabase } = require('./db');
const server = require('./server'); // triggers auto-seed on first require, since the DB above is empty

let baseUrl;
let fixture; // ids of known rows this file's own tests can rely on

test.before(() => new Promise((resolve) => {
  server.listen(0, () => {
    baseUrl = `http://localhost:${server.address().port}`;

    // Add a few known, controlled rows on top of the auto-seeded data,
    // so assertions don't depend on the random seed's exact output.
    const db = openDatabase(TEST_DB_PATH);
    db.exec("INSERT INTO books (title, author, published_year) VALUES ('Fixture Book', 'Fixture Author', 2020)");
    const bookId = Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
    db.exec(`INSERT INTO copies (book_id, copy_number) VALUES (${bookId}, 1)`);
    const copyIdRow = db.prepare('SELECT id FROM copies WHERE book_id = ? AND copy_number = 1').get(bookId);
    db.exec("INSERT INTO members (name, email, joined_at) VALUES ('Fixture Member', 'fixture@example.com', '2024-01-01')");
    const memberId = Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);

    fixture = { bookId, copyId: copyIdRow.id, memberId, bookTitle: 'Fixture Book' };
    db.close();
    resolve();
  });
}));

test.after(() => new Promise((resolve) => server.close(resolve)));

function req(path, options = {}) {
  return fetch(baseUrl + path, options);
}
function postJson(path, body) {
  return req(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

test('GET / returns 200 with service info', async () => {
  const res = await req('/');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).service, 'library-loans');
});

test('GET /members/:id/loans/current returns 400 for a non-numeric id, not a 500', async () => {
  const res = await req('/members/not-a-number/loans/current');
  assert.equal(res.status, 400);
  assert.equal((await res.json()).field, 'id');
});

test('GET /members/:id/loans/current returns 404 for a member that does not exist', async () => {
  const res = await req('/members/999999999/loans/current');
  assert.equal(res.status, 404);
});

test('a fresh member with no loans gets an empty list, not an error', async () => {
  const db = openDatabase(TEST_DB_PATH);
  db.exec("INSERT INTO members (name, email, joined_at) VALUES ('No Loans', 'noloans@example.com', '2024-01-01')");
  const id = Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
  db.close();

  const res = await req(`/members/${id}/loans/current`);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).loans, []);
});

test('borrowing an available copy returns 201 with the new loan', async () => {
  const res = await postJson('/loans', { copy_id: fixture.copyId, member_id: fixture.memberId });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.copy_id, fixture.copyId);
  assert.equal(body.returned_at, null);
});

test('the borrowed copy now shows up in the member\'s current loans, with the title', async () => {
  const res = await req(`/members/${fixture.memberId}/loans/current`);
  const body = await res.json();
  assert.ok(body.loans.some((l) => l.title === fixture.bookTitle));
});

test('borrowing an already-out copy returns 409, and does not create a second row', async () => {
  const attempt = await postJson('/loans', { copy_id: fixture.copyId, member_id: fixture.memberId });
  assert.equal(attempt.status, 409);

  const db = openDatabase(TEST_DB_PATH);
  const activeCount = db.prepare('SELECT COUNT(*) AS n FROM loans WHERE copy_id = ? AND returned_at IS NULL').get(fixture.copyId).n;
  db.close();
  assert.equal(Number(activeCount), 1);
});

test('POST /loans validates copy_id and member_id, naming the field', async () => {
  assert.equal((await postJson('/loans', {})).status, 400);
  assert.equal((await postJson('/loans', { copy_id: 'not-a-number', member_id: 1 })).status, 400);
  const missingCopy = await postJson('/loans', { copy_id: 999999, member_id: fixture.memberId });
  assert.equal(missingCopy.status, 400);
  assert.equal((await missingCopy.json()).field, 'copy_id');
});

test('POST /loans with malformed JSON returns 400, not 500', async () => {
  const res = await req('/loans', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
  assert.equal(res.status, 400);
});

test('returning a loan frees the copy up for someone else', async () => {
  const db = openDatabase(TEST_DB_PATH);
  const activeLoan = db.prepare('SELECT id FROM loans WHERE copy_id = ? AND returned_at IS NULL').get(fixture.copyId);
  db.close();

  const returnRes = await postJson(`/loans/${activeLoan.id}/return`, {});
  assert.equal(returnRes.status, 200);

  const secondBorrow = await postJson('/loans', { copy_id: fixture.copyId, member_id: fixture.memberId });
  assert.equal(secondBorrow.status, 201);
});

test('returning an already-returned loan returns 409, not 500', async () => {
  const db = openDatabase(TEST_DB_PATH);
  const anyReturned = db.prepare('SELECT id FROM loans WHERE returned_at IS NOT NULL LIMIT 1').get();
  db.close();

  const res = await postJson(`/loans/${anyReturned.id}/return`, {});
  assert.equal(res.status, 409);
});

test('an unknown route returns 404, not 500', async () => {
  const res = await req('/definitely/not/a/route');
  assert.equal(res.status, 404);
});
