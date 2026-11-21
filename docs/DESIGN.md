# CampusPass design notes

This document explains how the system protects its one promise, and records the decisions behind it.
Use it as the technical section of the project report.

## 1. The invariant

For every event, at every moment that no transaction is in flight:

```
seats_left + (bookings with status pending, confirmed or checked_in) = total_seats
seats_left >= 0
```

`seats_left` is a counter and a booking is a row. They are two copies of the same fact, and any bug that updates one without the other makes them drift apart.
The database view `event_reconciliation` computes both sides. The organizer dashboard shows the result, `GET /api/events/:id/reconcile` returns it, and every test asserts it.

## 2. Data model

| Table | Purpose | Notable constraints |
|---|---|---|
| `users` | accounts | unique email, role is `student` or `organizer` |
| `events` | capacity and status | `CHECK (seats_left >= 0)`, `CHECK (seats_left <= total_seats)`, status is `draft`, `open` or `closed`; `lock_mode`; `requires_approval` |
| `bookings` | one row = one seat | unique partial index on `(event_id, student_id)` where status is `pending`, `confirmed` or `checked_in`; unique `qr_token` |
| `waitlist` | first come, first served | unique `(event_id, student_id)`, ordered by `id` |

Cancelled bookings stay in the table with `cancelled_at`, so a student can book the same event again later and the history is kept.

## 3. Booking: two mechanisms

Both run in one transaction and change `seats_left` and the booking row together.

**Row lock** (`bookSeatWithRowLock`): `SELECT ... FOR UPDATE` locks the event row, so concurrent requests queue behind it. Inside the lock the code checks status, duplicate booking, remaining seats and the student limit, inserts the booking, then decrements the counter.

**Atomic update** (`bookSeatWithAtomicUpdate`): `UPDATE events SET seats_left = seats_left - 1 WHERE id = $1 AND status = 'open' AND seats_left > 0`. PostgreSQL locks the row for the update and re-checks the condition after waiting, so exactly `seats_left` requests can match. A request that matches nothing asks why (closed, duplicate, sold out) and rolls back.

Why both are correct: the check and the write are a single indivisible step (a lock, or a conditional update), so no request can read "1 seat left" while another is about to take it.

### What the naive version gets wrong

`bookSeatNaive` (only reachable with `?strategy=naive` outside production) does: read `seats_left`, if above zero insert a booking, then decrement. With 500 simultaneous requests all 500 read "100 seats left" before any decrement. All 500 insert a booking row. The first 100 decrements succeed, and the other 400 hit the `CHECK` constraint and return 500, but their booking rows are already saved.
Result: 500 confirmed bookings for 100 seats, 400 students told "failed" who still hold a ticket, and a counter (`0`) that no longer matches the rows. `npm run test:naive` shows exactly this.

## 4. Cancelling, the waitlist and promotion

Cancelling in one transaction: lock the event, lock the booking, mark it `cancelled`, then hand the seat to the first eligible waiter or return it to the pool.

- If a waiter qualifies, they get a booking in the same transaction and `seats_left` does not change. At no moment is the seat visible as free, so a student who is not on the waitlist cannot grab it.
- If nobody qualifies, `seats_left` goes up by one.
- A waiter who already holds a seat is dropped from the list. A waiter at their booking limit keeps their place and is skipped.
- If the event is closed, the seat returns to the pool and nobody is promoted.

Joining the waitlist takes the same event lock and is only allowed when the event is open and sold out, which removes the race "I joined just after a seat was freed".

## 5. Per-student booking limit

A student may hold at most `MAX_ACTIVE_BOOKINGS` (default 3) confirmed bookings for events that have not started. This constraint is on the other side of the relation: it limits a student across events, not an event across students.
To make it race-free when one student books several events at the same instant, the student row is locked (`FOR NO KEY UPDATE`) before counting. `tests/limit.js` fires 6 simultaneous bookings for one student and requires exactly 3 to succeed, under both mechanisms.

## 6. Lock order and deadlocks

Every transaction that needs more than one lock takes them in the same order:

```
event row  ->  booking row  ->  student row
```

Because nobody ever waits for an earlier lock while holding a later one, a cycle (a deadlock) cannot form.

## 7. Organizer controls

- **Locking mode per event** (`events.lock_mode`): the booking route reads it and calls the row-lock or atomic function. Both keep the same guarantee.
- **Approval** (`events.requires_approval`): a booking is inserted as `pending` in the same transaction that takes the seat, so a pending booking counts as active everywhere (capacity, the unique index, the per-student limit, the reconciliation view). Approving only flips `pending` to `confirmed` under the event lock and never changes `seats_left`. Rejecting is a normal cancel, which promotes the waitlist (the promoted booking is pending too). Nothing expires, so there is no leaked capacity.
- **Capacity change:** under the event lock, `total_seats` and `seats_left` are recomputed from the booked count; it cannot go below booked seats, and new seats go to the waitlist first.
- **Force-book:** an organizer can book a student by email even when bookings are closed or the student is at their limit, but never beyond capacity.

## 8. Decisions

- **Hold or approval:** approval is optional per event (above). Without it a booking is confirmed instantly. There is no timed hold and no payment step.
- **Partial fulfilment:** not applicable, a booking is exactly one seat.
- **Append-only history:** not claimed. See `SCOPE.md` section 7.

## 9. Error contract

| Status | Code | When |
|---|---|---|
| 201 | none | booked, joined the waitlist, registered |
| 400 | `BAD_INPUT` | invalid id, email, password, seats or date |
| 401 | `UNAUTHENTICATED`, `BAD_CREDS`, `BAD_TOKEN` | not logged in, wrong login, invalid or tampered QR code |
| 403 | `FORBIDDEN` | wrong role, someone else's booking or event, missing organizer invite code |
| 404 | `NOT_FOUND` | no such event or booking (drafts look like they do not exist to students) |
| 409 | `SOLD_OUT` | no seats left |
| 409 | `ALREADY_BOOKED` | the student already has a seat for this event |
| 409 | `BOOKING_LIMIT_REACHED` | the student holds the maximum of upcoming bookings |
| 409 | `SEATS_AVAILABLE` | tried to join the waitlist while seats remain |
| 409 | `ALREADY_WAITLISTED` | already on the waitlist |
| 409 | `INVALID_STATE` | cancelling a ticket that is not pending or confirmed; approving a booking that is not pending |
| 409 | `CAPACITY_BELOW_BOOKED` | lowering seats below the number already booked |
| 409 | `STUDENT_NOT_FOUND` | force-booking an email that is not a student account |
| 409 | `ALREADY_CHECKED_IN`, `CANCELLED` | the ticket was already used or cancelled |
| 409 | `EMAIL_TAKEN` | registering an existing email |
| 422 | `BOOKINGS_CLOSED` | the organizer closed bookings |
| 429 | `TOO_MANY_ATTEMPTS` | 10 failed logins for one email and address in 15 minutes |
| 500 | `INTERNAL` | unexpected. The real error is logged on the server and never sent to the client. |

## 10. QR tickets

The ticket code is `base64url(bookingId:eventId:HMAC-SHA256(bookingId:eventId))`. Check-in recomputes the signature with a constant-time comparison, then marks the booking `checked_in` in a single conditional `UPDATE` that also requires the booking to belong to one of the calling organizer's own events and to be `confirmed`. A code is therefore single use, cannot be forged without the server secret, and cannot be used at another organizer's event.

## 11. Security measures

- Sessions in PostgreSQL, `httpOnly` and `sameSite=lax` cookies, `secure` in production, session id regenerated on login.
- Passwords hashed with bcrypt. Failed logins rate limited. Organizer sign-up needs an invite code.
- Role and ownership checked on every organizer route. Students can only see and cancel their own bookings.
- All input validated. A bad `:id` is a 400, never a database error. Error messages never include internals.
- The frontend escapes every user-supplied value, and the Content-Security-Policy (`script-src 'self'`) blocks inline scripts as a second layer.
- Secrets come from `.env`, which is not committed. `.env.example` holds placeholders only.

## 12. Benchmark method

`npm run test:bench` fires 500 simultaneous booking requests for a 100-seat event, 5 runs per mechanism (set `BENCH_RUNS` to change), alternating which mechanism goes first so warm-up does not favour one.
Each run uses a fresh event, checks that the outcome is correct (exactly 100 successes, 400 conflicts, reconciled), and records total time, throughput and p50/p95 latency. The medians are written to `docs/benchmark-latest.md`.

Read the numbers with care:

- All requests contend for one event row, which is the worst case for both mechanisms.
- The connection pool holds 20 connections, so most requests also wait for a free connection. Latency includes that queueing.
- Sessions are looked up in PostgreSQL on every request, which adds the same cost to both mechanisms.
- Results depend on the machine. Run the benchmark on the laptop you present from and quote those numbers.

## 13. Limitations and future work

- One very hot event serialises on a single row lock. Sharding the counter across several rows would raise throughput at the cost of complexity.
- Sold-out waiters are not notified outside the app (no email or SMS).
- Ticket codes do not expire. They stop working when the booking is cancelled or used.
- Organizer sign-up relies on one shared invite code.
- The login rate limiter is in memory, so it resets when the server restarts and does not span several servers.
