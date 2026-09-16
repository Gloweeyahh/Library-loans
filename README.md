# library-loans

A small library system — books, copies, members, and loans — built
around one specific query and the index that makes it fast: for a
given member, the books they currently have out.

Plain Node, using the built-in `node:sqlite` module. No framework, no
ORM, no separate database to provision. See "Why `node:sqlite`" below.

**Live URL:** https://library-loans.onrender.com/

## Schema

```
books    (id, title, author, published_year)
copies   (id, book_id → books.id, copy_number)
members  (id, name, email, joined_at)
loans    (id, copy_id → copies.id, member_id → members.id,
          borrowed_at, due_at, returned_at)
```

A **book** is the abstract work ("Pride and Prejudice"); a **copy** is
one physical instance of it a member can actually borrow — a library
can own three copies of the same book, and they get loaned out
independently. A **loan** connects one copy to one member for one
borrowing period; `returned_at` is `NULL` while it's still out.

There's no `status` column on `copies` recording "available" or "on
loan." That's deliberate: whether a copy is out is entirely derivable
from whether it has a loan with `returned_at IS NULL`, and storing that
same fact twice (once as a status flag, once as the loan history) is
exactly how the two copies of the truth drift apart — the flag says
"available" while a loan row says otherwise, because something updated
one and not the other. One source of truth, always queried, never
cached in a column that can go stale.

## Seed data

`node seed.js` generates:

- 3,000 books
- ~6,000 copies (1-3 per book)
- 1,500 members
- **16,000+ loans** — most historical and returned, roughly 20% of
  copies currently checked out (so `returned_at IS NULL` for those)

Loans are generated per copy, historical ones first, with at most one
final loan left active — so the seed can never attempt two simultaneous
active loans on one copy. It satisfies the constraint below by
construction, not by chance.

The running service seeds itself automatically on first boot, if its
database is empty — see "Deploying."

## The endpoint this project is about

```
GET /members/:id/loans/current
```

Returns the books a member currently has out, most recently borrowed
first:

```json
{ "loans": [
  { "title": "The Silent River", "due_at": "2026-10-03T00:00:00.000Z" },
  { "title": "A Broken Kingdom", "due_at": "2026-09-28T00:00:00.000Z" }
] }
```

The query:

```sql
SELECT b.title, l.due_at
FROM loans l
JOIN copies c ON c.id = l.copy_id
JOIN books b ON b.id = c.book_id
WHERE l.member_id = ? AND l.returned_at IS NULL
ORDER BY l.borrowed_at DESC
```

## The query plan, before and after the index

Measured with `node bench.js`, which seeds its own throwaway database
(16,460 loans, 6,041 copies, 3,000 books, 1,500 members) and runs the
query above 50 times against a real member, before and after adding
the index — run it yourself to reproduce these numbers rather than
take this README's word for it.

**Before** (only the primary keys, plus the constraint index from
"How double-lending is prevented" below — no index built for *this*
query):

```
SCAN l USING INDEX idx_one_active_loan_per_copy
SEARCH c USING INTEGER PRIMARY KEY (rowid=?)
SEARCH b USING INTEGER PRIMARY KEY (rowid=?)
USE TEMP B-TREE FOR ORDER BY

min 0.18ms · median 0.22ms · max 0.43ms
```

That's a more interesting starting point than a naive full scan, and
worth being honest about: SQLite's planner noticed it could walk
`idx_one_active_loan_per_copy` — the constraint index, not a
performance index, originally added for a completely different reason
— to jump straight to just the rows where `returned_at IS NULL`
(roughly 3,000 of the 16,460 total), instead of scanning all of them.
It still checks `member_id` on every one of those rows by hand, and
still needs a temporary B-tree to sort the results by `borrowed_at`,
since nothing tells it what order those rows come in.

**After** adding:

```sql
CREATE INDEX idx_loans_member_active_recent
  ON loans(member_id, returned_at, borrowed_at DESC);
```

```
SEARCH l USING INDEX idx_loans_member_active_recent (member_id=? AND returned_at=?)
SEARCH c USING INTEGER PRIMARY KEY (rowid=?)
SEARCH b USING INTEGER PRIMARY KEY (rowid=?)

min 0.01ms · median 0.01ms · max 0.04ms
```

The `SCAN` becomes a `SEARCH` — SQLite jumps directly to this member's
rows instead of checking every row for a match — and `USE TEMP B-TREE
FOR ORDER BY` disappears entirely, because `borrowed_at DESC` as the
index's third column means the matching rows already come out of the
index in the exact order the query asks for.

**Both numbers are comfortably under the 200ms the brief asks for** —
at this data size, SQLite is fast enough that the *absolute* timing
difference (roughly 20x, but both sides are sub-millisecond) isn't the
real story. The real story is the query plan itself: a full-table-ish
scan plus a sort, versus a direct index lookup with the sort already
built in. That difference matters more and more as the table grows —
a member with a long loan history, or a table with a hundred times more
rows, is where the "before" version would actually start to hurt.

## How double-lending is prevented

```sql
CREATE UNIQUE INDEX idx_one_active_loan_per_copy
  ON loans(copy_id)
  WHERE returned_at IS NULL;
```

A **partial unique index**: unique on `copy_id`, but only among rows
where `returned_at IS NULL`. A copy can have many loans over its
lifetime — that's fine, they all have different `returned_at` values
once returned — but it can never have two rows with `returned_at IS
NULL` at once. The database itself rejects the second `INSERT` with a
`UNIQUE constraint failed` error; `server.js` catches that specific
error and turns it into a `409 Conflict` response, naming the problem.

I chose a schema-level constraint over an application-level check
("look up the copy, see if it's out, only then insert") for one
reason: a check-then-insert has a race condition built into it. Two
requests to borrow the same copy can both run the "is it out?" query,
both see "no," and both proceed to insert — nothing stops that unless
the check and the insert happen as one atomic operation the database
enforces, not two separate steps application code has to remember to
wrap correctly every single time, in every place a loan might ever get
created. The constraint can't be bypassed by a code path that forgets
to check, because there's no check to forget — the insert itself either
succeeds or it doesn't.

The trade-off: a caller sees the failure as an exception to catch
(a thrown error, translated to a 409) rather than a boolean a
"canBorrow()" function returns ahead of time. That's a deliberate
choice too — asking "can I?" and then doing it are still two steps,
with the same race between them; only the insert itself, guarded by
the constraint, is actually atomic.

## Why `node:sqlite`

Node shipped a built-in SQLite module — no `npm install`, nothing to
compile, nothing to provision as a separate service. That matters more
here than it sounds: it means there's no managed Postgres instance to
spin up, connect to, and pay for (or lose after a free trial expires),
and no native dependency that might fail to build on whatever platform
this gets deployed to. The trade-off, stated plainly: `node:sqlite` is
still an experimental Node API (it prints a warning on startup, which
`--no-warnings` suppresses) and needs a recent Node version — `>=22.5.0`,
set in `package.json`'s `engines` field. For a project this size, that
trade felt worth it; a system meant to run for years on whatever Node
version happens to be installed would be a different decision.

## What's deliberately not implemented

- **Renewals.** Extending a due date isn't here — it would need its own
  endpoint and its own thinking about whether a renewal resets
  `borrowed_at` for the "most recent" ordering or not.
- **Holds/reservations** for a copy that's currently out.
- **Late fees** or any concept of an overdue loan beyond `due_at` being
  in the past (which the data supports computing, just isn't surfaced
  as its own field or endpoint).
- **Authentication.** Any caller can borrow or return on behalf of any
  member id — there's no session or identity check. Out of scope for
  what this brief is measuring.
- **Pagination** on `/books` and `/members` (both simply cap at 100
  rows) — fine at this scale, not built for it to grow past that.

## Running it locally

```
node seed.js      # populates the database (also happens automatically on first boot)
node server.js
```

No install step. Try the endpoint that matters:

```
curl http://localhost:3000/members/1/loans/current
```

## Running the checks

```
node --test
```

Two files: `schema.test.js` (the double-lending constraint and foreign
keys, directly against the database — no server involved) and
`server.test.js` (starts the real server on a random port and hits it
with real HTTP requests, including borrowing an already-out copy end
to end and confirming it's rejected with one row left, not two).

A passing run ends with:

```
# tests 18
# suites 0
# pass 18
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## Reproducing the benchmark

```
node bench.js
```

Seeds its own throwaway database, measures the query plan and timing
before the index, adds the index, measures again. This is exactly what
produced the numbers in "The query plan, before and after the index"
above.

## Deploying

Same approach as the rest of this portfolio: [Render](https://render.com)'s
free tier, no credit card, connects straight to GitHub.

1. Push this repo to GitHub.
2. Render: **New → Web Service** → connect the repo.
3. Build command: leave blank.
4. Start command: `node --no-warnings server.js`.
5. Deploy.

The service seeds itself automatically on first boot if its database is
empty, so there's no manual seeding step to remember on a fresh
deploy. Free-tier services sleep after 15 minutes idle and take
30-60 seconds to wake on the next request.

## Files

- `schema.js` — table definitions and the double-lending constraint
- `perf-index.js` — the one index this project measures the effect of
- `db.js` — opens the database, applies schema and indexes
- `seed.js` — generates books, copies, members, and 16,000+ loans
- `server.js` — HTTP routing and the graded endpoint
- `bench.js` — reproduces the before/after query plan measurement
- `schema.test.js`, `server.test.js` — automated checks
