/**
 * Seeds the database with enough data to make the performance and
 * query-plan story in the README real rather than asserted: 3,000
 * books, ~6,000 copies, 1,500 members, and comfortably over 10,000
 * loans.
 *
 * Loans are generated per copy: a handful of historical (returned)
 * loans, then — for a random subset of copies — one final loan left
 * active (returned_at NULL). Generating them in that order means the
 * seed can never attempt two active loans on the same copy; it
 * satisfies idx_one_active_loan_per_copy by construction rather than
 * by getting lucky.
 *
 * Run with: node seed.js
 */

const { openDatabase } = require('./db');

const ADJECTIVES = ['Silent', 'Hidden', 'Last', 'Broken', 'Golden', 'Distant', 'Quiet',
  'Forgotten', 'Wild', 'Eternal', 'Secret', 'Lost', 'Endless', 'Bitter', 'Sweet', 'Dark',
  'Bright', 'Ancient', 'Restless', 'Patient', 'Crooked', 'Open', 'Narrow', 'Long'];
const NOUNS = ['River', 'Garden', 'Shadow', 'Kingdom', 'Storm', 'Letter', 'Bridge',
  'Mountain', 'Ocean', 'Forest', 'City', 'Star', 'Clock', 'Mirror', 'Door', 'Road',
  'House', 'Song', 'Winter', 'Summer', 'Harbor', 'Orchard', 'Market', 'Library'];
const FIRST_NAMES = ['Amaka', 'Tomiwa', 'Daniel', 'Grace', 'Lauren', 'Michael', 'Aisha',
  'Chidinma', 'Samuel', 'Ijeoma', 'Halima', 'Emeka', 'Zainab', 'Kelechi', 'Feyisayo',
  'Blessing', 'Uche', 'Ndidi', 'Tunde', 'Ngozi', 'Segun', 'Yewande', 'Obinna', 'Fatima'];
const LAST_NAMES = ['Okafor', 'Bello', 'Osei', 'Effiong', 'Kim', 'Ade', 'Mustapha',
  'Nnamdi', 'Nwosu', 'Yusuf', 'Ibe', 'Lawal', 'Umeh', 'Ajayi', 'Eze', 'Chukwu', 'Obi',
  'Adeyemi', 'Nnaji', 'Balogun'];

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function randomTitle() {
  const templates = [
    () => `The ${pick(ADJECTIVES)} ${pick(NOUNS)}`,
    () => `${pick(NOUNS)} of ${pick(NOUNS)}`,
    () => `A ${pick(ADJECTIVES)} ${pick(NOUNS)}`,
    () => `${pick(ADJECTIVES)} ${pick(NOUNS)}`,
  ];
  return pick(templates)();
}

function randomName() {
  return `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

function daysFromDate(iso, n) {
  const d = new Date(iso);
  d.setDate(d.getDate() + n);
  return d.toISOString();
}

const LOAN_PERIOD_DAYS = 21;
const BOOK_COUNT = 3000;
const MEMBER_COUNT = 1500;

function seed(db) {
  const ownsDb = !db;
  if (!db) db = openDatabase();

  console.log('Clearing existing data...');
  db.exec('DELETE FROM loans');
  db.exec('DELETE FROM copies');
  db.exec('DELETE FROM members');
  db.exec('DELETE FROM books');

  db.exec('BEGIN');

  console.log(`Inserting ${BOOK_COUNT} books...`);
  const insertBook = db.prepare('INSERT INTO books (title, author, published_year) VALUES (?, ?, ?)');
  for (let i = 0; i < BOOK_COUNT; i++) {
    insertBook.run(randomTitle(), randomName(), 1960 + Math.floor(Math.random() * 65));
  }

  console.log(`Inserting ${MEMBER_COUNT} members...`);
  const insertMember = db.prepare('INSERT INTO members (name, email, joined_at) VALUES (?, ?, ?)');
  const memberIds = [];
  for (let i = 0; i < MEMBER_COUNT; i++) {
    const name = randomName();
    const email = `${name.toLowerCase().replace(/\s+/g, '.')}.${i}@example.com`;
    const result = insertMember.run(name, email, daysAgo(30 + Math.floor(Math.random() * 1500)));
    memberIds.push(Number(result.lastInsertRowid));
  }

  console.log('Inserting copies and loans...');
  const insertCopy = db.prepare('INSERT INTO copies (book_id, copy_number) VALUES (?, ?)');
  const insertLoan = db.prepare(
    'INSERT INTO loans (copy_id, member_id, borrowed_at, due_at, returned_at) VALUES (?, ?, ?, ?, ?)'
  );

  let copyCount = 0;
  let loanCount = 0;

  for (let bookId = 1; bookId <= BOOK_COUNT; bookId++) {
    const copiesForThisBook = 1 + Math.floor(Math.random() * 3); // 1-3 copies per book

    for (let copyNumber = 1; copyNumber <= copiesForThisBook; copyNumber++) {
      const copyResult = insertCopy.run(bookId, copyNumber);
      const copyId = Number(copyResult.lastInsertRowid);
      copyCount++;

      // A handful of historical, already-returned loans for this copy.
      const historicalLoans = 1 + Math.floor(Math.random() * 4); // 1-4
      let cursor = daysAgo(30 + Math.floor(Math.random() * 1200));

      for (let h = 0; h < historicalLoans; h++) {
        const borrowedAt = cursor;
        const dueAt = daysFromDate(borrowedAt, LOAN_PERIOD_DAYS);
        // Most returns happen on or a little after the due date.
        const returnedAt = daysFromDate(dueAt, Math.floor(Math.random() * 10) - 5);
        insertLoan.run(copyId, pick(memberIds), borrowedAt, dueAt, returnedAt);
        loanCount++;
        cursor = daysFromDate(returnedAt, 1 + Math.floor(Math.random() * 20));
      }

      // ~20% of copies are currently out — exactly one active loan,
      // added last, after every historical loan for this copy.
      if (Math.random() < 0.2) {
        const borrowedAt = daysAgo(Math.floor(Math.random() * LOAN_PERIOD_DAYS));
        const dueAt = daysFromDate(borrowedAt, LOAN_PERIOD_DAYS);
        insertLoan.run(copyId, pick(memberIds), borrowedAt, dueAt, null);
        loanCount++;
      }
    }
  }

  db.exec('COMMIT');

  console.log(`Done: ${BOOK_COUNT} books, ${copyCount} copies, ${MEMBER_COUNT} members, ${loanCount} loans.`);
  if (ownsDb) db.close();
  return { bookCount: BOOK_COUNT, copyCount, memberCount: MEMBER_COUNT, loanCount };
}

if (require.main === module) {
  seed();
}

module.exports = { seed };
