# CampusPass - Scope & Contract

## 1. Project Overview

CampusPass is an Event & Talk Ticketing System designed for
campus events, guest talks, fests, workshops, and society meetups.

Its primary goal is to guarantee that students can successfully
enter an event after receiving a confirmed booking.

## 2. Technology Stack

- Backend: Node.js + Express
- Language: JavaScript
- Database: PostgreSQL 15+ (PostgreSQL 16 in Docker)
- Database Driver: pg
- Frontend: HTML, CSS, Vanilla JavaScript
- Authentication: express-session (sessions stored in PostgreSQL) + bcryptjs
- QR codes: qrcode, signed with HMAC-SHA256
- Security headers: helmet (strict Content-Security-Policy)
- Environment Variables: dotenv
- Logging: morgan
- Testing: Node.js fetch / Promise.all against a running server
- Development Environment: VS Code

## 3. In-Scope Features

1. Student and organizer registration/login (organizer sign-up needs an invite code).
2. Organizer event creation and publishing (draft, open, closed).
3. Student event browsing with live seat counts.
4. Concurrent-safe seat booking (two mechanisms, benchmarked).
5. Duplicate booking prevention.
6. Booking cancellation and seat restoration.
7. Waitlist with automatic, first-come-first-served promotion.
8. QR ticket generation with HMAC signatures.
9. QR-based event check-in (single use, organizer only).
10. Live organizer dashboard with a counter-vs-rows reconciliation check.
11. Manual booking closure (and reopening).
12. Per-student booking limits (default 3 upcoming bookings).
13. Organizer controls: change seat capacity, book a student by email, choose the locking mode per event, optional booking approval.
14. Concurrency and benchmark testing.

## 4. Deliberately Excluded

Each item below is a conscious decision, not an oversight.

| Excluded | Why |
|---|---|
| Online payments | Out of the course scope. A payment step would also turn every booking into a held seat that needs expiry handling, which adds a second concurrency problem unrelated to the one this project studies. |
| Paid or tiered tickets | Follows from the above. Every event has one free ticket type. |
| Multi-seat bookings | One booking is exactly one seat. This keeps the capacity maths and the partial-fulfilment question trivial (see section 7). |
| Email and SMS notifications | Needs an external service. Students see their ticket and waitlist position in the app. |
| Native mobile applications | The web interface is responsive. |
| Multi-tenant organizations | One organizer owns their own events; there are no teams or shared ownership. |
| Social media integration and third-party marketplaces | Not part of the booking guarantee. |
| Advanced analytics | The dashboard shows live counts only. |
| Seat maps and assigned seats | Capacity is a count, not a position. |
| Organizer identity verification | Organizers sign up with a shared invite code, which is enough for a campus deployment. |

## 5. Target Development Effort

Estimated total effort: 35 hours.

## 6. Core Concurrency Guarantee

The system must never oversell event capacity.

Booking operations use PostgreSQL transactions
with row-level locking and atomic conditional updates.

The seat count and booking record are modified
together within the same transaction.

Database constraints prevent negative seat counts.

The invariant that is tested everywhere:

    seats_left + (confirmed + checked-in bookings) = total_seats

See `docs/DESIGN.md` for how each operation protects it.

## 7. Design Decisions

**Hold or approval?** Optional approval, per event. By default a booking is confirmed at the moment it is
made. If the organizer turns approval on, a booking is `pending` and already holds its seat
(taken in the same transaction) until the organizer approves or rejects it. There is no timer and no
payment step, so no hold can expire and leak capacity.

**Partial fulfilment.** Does not apply. Every booking is exactly one seat, so a request is
either fully satisfied or refused with `SOLD_OUT`.

**Append-only history.** Not claimed. A booking row changes status in place (`confirmed`,
`cancelled`, `checked_in`) and cancelled rows are kept, with timestamps, rather than deleted.
If the project later needs a tamper-proof audit trail it would need a separate log table with
`REVOKE UPDATE, DELETE` and a unique per-event sequence number.

**Waitlist fairness.** Strictly first come, first served (by waitlist id). A freed seat goes to the
head of the line inside the cancelling transaction, so a student who is not on the waitlist
can never take it. A waiter who already hit their booking limit keeps their place but is skipped.

## 8. Definition of Done

Each box was ticked only after the named test passed against a real PostgreSQL database.

- [x] Smoke test: 1 seat, 2 concurrent requests. (`tests/smoke.js`)
- [x] Exactly 1 successful booking and 1 conflict. (`tests/smoke.js`)
- [x] Scale test: 100 seats, 500 concurrent requests. (`tests/scale.js`)
- [x] Exactly 100 successes and 400 conflicts, zero 500s. (`tests/scale.js`)
- [x] Exactly 100 confirmed booking records. (`tests/scale.js`)
- [x] seats_left equals zero after scale test. (`tests/scale.js`)
- [x] Both booking mechanisms implemented. (`server/bookingService.js`)
- [x] Benchmark both mechanisms at 500 concurrent requests, repeated, with throughput and p50/p95 latency. (`tests/bench.js`)
- [x] A naive version fails the same test, proving the test can catch the race. (`npm run test:naive`)
- [x] Cancellation restores available capacity. (`tests/waitlist.js`)
- [x] Cancel-vs-book concurrency test passes, 25 rounds. (`tests/cancel-vs-book.js`)
- [x] Waitlist promotion is atomic and first come, first served. (`tests/waitlist.js`, `tests/cancel-vs-book.js`)
- [x] Duplicate bookings are prevented, including 5 simultaneous clicks by one student. (`tests/smoke.js`)
- [x] Per-student booking limit holds even when one student books several events at once. (`tests/limit.js`)
- [x] QR check-in verifies HMAC signatures, is single use and organizer only. (`tests/checkin.js`)
- [x] Organizer overrides, per-event locking mode and approval keep the counter reconciled. (`tests/organizer-controls.js`)
- [x] Counter and booking rows reconcile for every event. (`tests/invariants.js` and every scale test)
- [x] Negative seat counts are impossible. (`CHECK` constraint, `tests/invariants.js`)
- [x] Permissions and input validation never produce a 500. (`tests/authz.js`)
- [x] Organizer dashboard displays live arrivals (polls every 2 seconds). Checked by hand in a browser, not by `npm test`.

## 9. Completion Criteria

The project is complete only after all required tests
pass against a real PostgreSQL database: `npm test`.
