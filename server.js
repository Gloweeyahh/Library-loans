/**
 * library-loans — plain Node `http` + the built-in `node:sqlite`
 * module. No framework, no ORM, no external database to provision —
 * see README for why.
 */

const http = require('http');
const { openDatabase } = require('./db');
const { seed } = require('./seed');

const PORT = process.env.PORT || 3000;

const db = openDatabase();

// A freshly deployed instance (Render's free tier starts with an
// empty disk) has no data yet — seed it automatically on first boot
// rather than requiring a manual step nobody can run once this is
// deployed. Safe to skip on every later restart: it only fires when
// the books table is actually empty.
const { count: bookCount } = db.prepare('SELECT COUNT(*) AS count FROM books').get();
if (bookCount === 0) {
  console.log('No data found — seeding on first boot...');
  seed(db);
}

const currentLoansStmt = db.prepare(`
  SELECT b.title, l.due_at
  FROM loans l
  JOIN copies c ON c.id = l.copy_id
  JOIN books b ON b.id = c.book_id
  WHERE l.member_id = ? AND l.returned_at IS NULL
  ORDER BY l.borrowed_at DESC
`);

const memberExistsStmt = db.prepare('SELECT id FROM members WHERE id = ?');
const copyExistsStmt = db.prepare('SELECT id FROM copies WHERE id = ?');
const insertLoanStmt = db.prepare(
  'INSERT INTO loans (copy_id, member_id, borrowed_at, due_at, returned_at) VALUES (?, ?, ?, ?, NULL)'
);
const returnLoanStmt = db.prepare(
  "UPDATE loans SET returned_at = ? WHERE id = ? AND returned_at IS NULL"
);
const loanExistsStmt = db.prepare('SELECT id FROM loans WHERE id = ?');

const LOAN_PERIOD_DAYS = 21;

function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 100_000) {
        reject(Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function isPositiveInteger(value) {
  return /^[1-9][0-9]*$/.test(value);
}

async function handleRequest(req, res) {
  const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const parts = pathname.split('/').filter(Boolean);

  if (pathname === '/' && req.method === 'GET') {
    return sendJson(res, 200, {
      service: 'library-loans',
      status: 'ok',
      endpoints: [
        'GET /books',
        'GET /members',
        'GET /members/:id/loans/current',
        'POST /loans',
        'POST /loans/:id/return',
      ],
    });
  }

  if (pathname === '/books' && req.method === 'GET') {
    const rows = db.prepare('SELECT id, title, author, published_year FROM books LIMIT 100').all();
    return sendJson(res, 200, { books: rows });
  }

  if (pathname === '/members' && req.method === 'GET') {
    const rows = db.prepare('SELECT id, name, email FROM members LIMIT 100').all();
    return sendJson(res, 200, { members: rows });
  }

  // GET /members/:id/loans/current — the endpoint this whole project is about.
  if (parts.length === 4 && parts[0] === 'members' && parts[2] === 'loans' && parts[3] === 'current' && req.method === 'GET') {
    const memberId = parts[1];
    if (!isPositiveInteger(memberId)) {
      return sendJson(res, 400, { field: 'id', message: 'member id must be a positive integer' });
    }
    if (!memberExistsStmt.get(Number(memberId))) {
      return sendJson(res, 404, { message: 'member not found' });
    }
    const rows = currentLoansStmt.all(Number(memberId));
    return sendJson(res, 200, { loans: rows });
  }

  if (pathname === '/loans' && req.method === 'POST') {
    let raw;
    try {
      raw = await readBody(req);
    } catch {
      return sendJson(res, 400, { field: 'body', message: 'request body is too large or unreadable' });
    }

    let body;
    try {
      body = raw.length ? JSON.parse(raw) : {};
    } catch {
      return sendJson(res, 400, { field: 'body', message: 'request body must be valid JSON' });
    }

    const { copy_id, member_id } = body || {};
    if (!Number.isInteger(copy_id) || copy_id <= 0) {
      return sendJson(res, 400, { field: 'copy_id', message: 'copy_id must be a positive integer' });
    }
    if (!Number.isInteger(member_id) || member_id <= 0) {
      return sendJson(res, 400, { field: 'member_id', message: 'member_id must be a positive integer' });
    }
    if (!copyExistsStmt.get(copy_id)) {
      return sendJson(res, 400, { field: 'copy_id', message: 'no copy exists with this id' });
    }
    if (!memberExistsStmt.get(member_id)) {
      return sendJson(res, 400, { field: 'member_id', message: 'no member exists with this id' });
    }

    const borrowedAt = new Date();
    const dueAt = new Date(borrowedAt);
    dueAt.setDate(dueAt.getDate() + LOAN_PERIOD_DAYS);

    try {
      const result = insertLoanStmt.run(copy_id, member_id, borrowedAt.toISOString(), dueAt.toISOString());
      return sendJson(res, 201, {
        id: Number(result.lastInsertRowid),
        copy_id,
        member_id,
        borrowed_at: borrowedAt.toISOString(),
        due_at: dueAt.toISOString(),
        returned_at: null,
      });
    } catch (err) {
      // This is idx_one_active_loan_per_copy doing its job — see
      // README, "How double-lending is prevented." A constraint
      // violation here means someone else already has this exact
      // copy out; that's a 409, not a bug and not a 500.
      if (String(err.message).includes('UNIQUE constraint failed')) {
        return sendJson(res, 409, { field: 'copy_id', message: 'this copy is already on loan' });
      }
      throw err;
    }
  }

  if (parts.length === 3 && parts[0] === 'loans' && parts[2] === 'return' && req.method === 'POST') {
    const loanId = parts[1];
    if (!isPositiveInteger(loanId)) {
      return sendJson(res, 400, { field: 'id', message: 'loan id must be a positive integer' });
    }
    if (!loanExistsStmt.get(Number(loanId))) {
      return sendJson(res, 404, { message: 'loan not found' });
    }
    const result = returnLoanStmt.run(new Date().toISOString(), Number(loanId));
    if (result.changes === 0) {
      return sendJson(res, 409, { message: 'this loan was already returned' });
    }
    return sendJson(res, 200, { id: Number(loanId), returned: true });
  }

  return sendJson(res, 404, { message: 'not found' });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) {
      sendJson(res, 400, { field: null, message: 'request could not be processed' });
    }
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`library-loans listening on port ${PORT}`);
  });
}

module.exports = server;
