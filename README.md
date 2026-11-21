# CampusPass - Event & Talk Ticketing System

CampusPass is a full-stack ticketing system for campus events that guarantees **zero overselling**,
even under heavy concurrent load.

The core promise: **if the app says a seat is available, booking it will actually get you in.**

## What it does

- Students browse events with live seat counts, book a seat, get a signed QR ticket, cancel, or join a waitlist when an event is full.
- When someone cancels, the freed seat goes to the first person on the waitlist automatically, with no gap another student could slip into.
- Organizers create and publish events, close or reopen bookings, watch bookings arrive live, and check students in by QR code.
- Organizers can override seats: change an event's capacity, or book a seat for a student by email (never beyond capacity).
- Each event has a locking mode (row lock or atomic update) that the organizer chooses, and an optional approval step where bookings stay pending, holding their seat, until the organizer approves or rejects them.
- A per-student limit (3 upcoming bookings by default) stops one student from hoarding seats.
- Every event shows a reconciliation check: `seats_left + booked = total seats`.

## Technology

| Part | Choice |
|---|---|
| Backend | Node.js 18+ and Express |
| Database | PostgreSQL 15+ through the `pg` pool |
| Frontend | HTML, CSS and vanilla JavaScript, served statically |
| Auth | `express-session` (stored in PostgreSQL) and `bcryptjs` |
| Tickets | `qrcode` images carrying an HMAC-SHA256 signed token |
| Security | `helmet` with a strict Content-Security-Policy |
| Tests | Plain Node scripts using `fetch` and `Promise.all` |

## Quick start

You need Node.js 18.11+ and either Docker or a local PostgreSQL.

```bash
# 1. Start PostgreSQL (host port 5433)
docker compose up -d

# 2. Configure
cp .env.example .env          # Windows: copy .env.example .env
#    then edit .env: set SESSION_SECRET, HMAC_SECRET and ORGANIZER_CODE

# 3. Install, create the tables, load demo data
npm install
npm run db:reset

# 4. Run
npm run dev                   # http://localhost:3000
```

Without Docker, create a database yourself (`createdb campuspass`) and point `DATABASE_URL` in `.env` at it.

### Demo accounts

All use the password `password123`.

| Account | Role |
|---|---|
| `org@test.com` | organizer |
| `stu1@test.com`, `stu2@test.com`, `stu3@test.com` | student |

New organizers can sign up on the registration page with the `ORGANIZER_CODE` from `.env`.

### Environment variables

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string. URL-encode special characters in the password (`@` is `%40`). |
| `PORT` | Server port, default 3000 |
| `NODE_ENV` | `development`, `test` or `production`. In production the two secrets below are required and the naive demo mode is disabled. |
| `SESSION_SECRET`, `HMAC_SECRET` | Long random strings for session cookies and QR signatures |
| `ORGANIZER_CODE` | Invite code needed to register as an organizer. Empty disables organizer sign-up. |
| `MAX_ACTIVE_BOOKINGS` | Per-student limit of upcoming bookings, default 3 |

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start with auto-restart (`node --watch`) |
| `npm start` | Start normally |
| `npm run migrate` | Create the tables. Refuses to touch an existing database. |
| `npm run migrate -- --reset` | Drop everything and recreate the tables |
| `npm run seed` | Load demo accounts and events |
| `npm run db:reset` | `migrate --reset` then `seed` |
| `npm test` | Start a test server and run every test (about a minute) |
| `npm run test:naive` | Show the oversell bug the tests exist to catch |
| `npm run test:bench` | Benchmark row lock against atomic update and write `docs/benchmark-latest.md` |
| `npm run test:clean` | Remove test data left in the database |

`npm test` needs the tables to exist (`npm run db:reset` once) and uses `DATABASE_URL` from `.env`.
Individual tests: `test:controls`, `test:smoke`, `test:scale`, `test:scale:atomic`, `test:cancel`, `test:waitlist`, `test:limit`, `test:checkin`, `test:authz`, `test:invariants`.
Those talk to a server you started yourself on `http://localhost:3000` (set `BASE_URL` to change it).

## How the concurrency guarantee works

Booking uses one of two mechanisms, both implemented and benchmarked:

1. **Row lock**: `SELECT ... FOR UPDATE` on the event row, check, insert the booking, decrement the counter, commit.
2. **Atomic update**: `UPDATE events SET seats_left = seats_left - 1 WHERE id = $1 AND status = 'open' AND seats_left > 0`, then insert the booking in the same transaction. No matching row means sold out.

The default is the row lock. The organizer can pick the mode per event, and `?strategy=atomic` on a booking request overrides it (used by the tests).
In both, the seat counter and the booking row change in one transaction, and a database `CHECK (seats_left >= 0)` is the last line of defence.
Cancelling, joining the waitlist and promoting a waiter take the same event lock, always in the order event, booking, student, so they cannot deadlock or race each other.

`npm run test:naive` runs the same 500-request test against a deliberately broken "check, then write" version. It books 500 seats on a 100-seat event, which is the failure the real tests prove is gone.
Full explanation, lock order, error codes and limitations: **[docs/DESIGN.md](docs/DESIGN.md)**.

## API

Errors always look like `{ "error": { "code": "SOLD_OUT", "message": "..." } }`.

| Method and path | Who | Purpose |
|---|---|---|
| `POST /api/auth/register`, `/login`, `/logout`; `GET /api/auth/me` | anyone | accounts |
| `GET /api/events` | anyone | open and closed events, live seat counts |
| `POST /api/events/:id/book` | student | book a seat |
| `POST` / `DELETE /api/events/:id/waitlist` | student | join or leave the waitlist |
| `GET /api/bookings/mine`, `/api/waitlist/mine` | student | my tickets, my place in line |
| `GET /api/bookings/:id/qr` | ticket owner | QR code image (PNG) |
| `DELETE /api/bookings/:id` | ticket owner, or the event's organizer | cancel, promoting the waitlist |
| `POST /api/events` | organizer | create (`status` of `open` or `draft`) |
| `PATCH /api/events/:id/status` | event's organizer | `open` (publish or reopen) or `closed` |
| `PATCH /api/events/:id/capacity` | event's organizer | change total seats (not below booked; extra seats go to the waitlist first) |
| `POST /api/events/:id/bookings` | event's organizer | book a seat for a student by `email` |
| `PATCH /api/events/:id/settings` | event's organizer | `lock_mode` (`rowlock` or `atomic`) and `requires_approval` |
| `POST /api/bookings/:id/approve` | event's organizer | approve a pending booking (reject it with `DELETE /api/bookings/:id`) |
| `GET /api/organizer/events`, `/api/events/:id/dashboard`, `/api/events/:id/reconcile` | event's organizer | dashboard data |
| `POST /api/checkin/:token` | event's organizer | check in a signed QR code |
| `GET /api/health` | anyone | server and database up |

## Project structure

```
server/      Express app, booking service (all locking), auth, errors, config
public/      Pages, one stylesheet, scripts in public/js
db/          schema.sql
scripts/     migrate.js, seed.js
tests/       helpers.js plus one file per test, run-all.js
docs/        DESIGN.md, DEMO.md, CHANGES.md
SCOPE.md     Scope, exclusions, design decisions, definition of done
```

## Troubleshooting

- **`password authentication failed`**: another PostgreSQL may be using port 5432. Use the Docker one on 5433 (as in `.env.example`) and check with `netstat -ano | findstr 5432`.
- **A container named `campuspass-db` already exists**: `docker rm -f campuspass-db`, then `docker compose up -d`.
- **`npm run migrate` says the database already has tables**: that is deliberate. Use `npm run migrate -- --reset` to wipe it.
- **Organizer sign-up says an invite code is required**: set `ORGANIZER_CODE` in `.env`, restart, and enter the same value on the sign-up page.
- **Tests fail to start**: run `npm run db:reset` once, and check that `DATABASE_URL` in `.env` works.
