# What changed and why

Each row answers an item from the refinement list. "Test" says what proves it.

## Bugs and gaps that broke the demo

| # | Problem | Fix | Test |
|---|---|---|---|
| 1 | Joining the waitlist returned a 500 (`position` column was `NOT NULL` but never set) | Dropped the column; order is by waitlist `id` and the position is counted | `waitlist.js` |
| 2 | Waitlist join had no checks | Locks the event, then requires: event exists and is published, bookings open, no seats left, not already seated, not already waiting | `waitlist.js` |
| 3 | Cancel could fail permanently if the first waiter already held a seat | Stale waiters are removed, waiters at their limit are skipped | `waitlist.js` |
| 4 | `cancel-vs-book.js` always failed (counted cancelled rows, never joined the waitlist) | Rewritten: 25 rounds, waitlist head must get the seat, a non-waitlisted student must not | `cancel-vs-book.js` |
| 5 | Students could not finish a booking in the UI (no pay button, QR, tickets page, cancel) | Booking confirms instantly. New *My tickets* page with QR, cancel and waitlist position | browser run |
| 6 | Holds never expired | Removed the pending-payment hold entirely. See `SCOPE.md` section 7 | `smoke.js`, `scale.js` |
| 7 | Dashboard *Check In* button was a stub | Calls the signed check-in endpoint | `checkin.js`, browser run |
| 8 | Organizer list showed every organizer's events | New `/api/organizer/events` | `authz.js` |
| 9 | No QR image | `qrcode` PNG at `/api/bookings/:id/qr`, owner only | `checkin.js` |
| 10 | Per-student booking limits not implemented | Limit of 3 upcoming bookings, race-free | `limit.js` |
| 11 | Closed events still showed *Book Seat* | Shows "Bookings closed" | browser run |

## Professor's feedback

| # | Problem | Fix |
|---|---|---|
| 12 | No reconciliation check | View `event_reconciliation`, API endpoint, dashboard line, asserted in every test |
| 13 | No naive baseline | `?strategy=naive` (never in production) and `npm run test:naive` |
| 14 | Thin benchmark | 500 requests, 5 runs each, alternating order, throughput and p50/p95, numeric winner, written to `docs/benchmark-latest.md` |
| 15 | Payments contradicted the scope | Hold removed; decisions written down |
| 16 | Missing documents | `SCOPE.md` (exclusions, decisions, ticked definition of done), `docs/DESIGN.md` (invariant, locking, error contract) |

## Security

| # | Problem | Fix | Test |
|---|---|---|---|
| 17 | Anyone could register as organizer | Invite code (`ORGANIZER_CODE`) | `authz.js` |
| 18 | Any logged-in user could check in any ticket | Organizer only, and only for their own events | `checkin.js`, `authz.js` |
| 19 | Any organizer could cancel any booking | Only the ticket owner or the event's organizer | `authz.js` |
| 20 | Stored XSS | Everything escaped, inline scripts removed, strict CSP | browser run |
| 21 | No input validation, raw errors leaked | Validation everywhere, bad ids are 400, one error format, no internals sent | `authz.js` |
| 22 | Secrets in `.env.example`, weak fallbacks, no rate limit | Placeholders, secrets required in production, `helmet`, failed-login rate limit, session regeneration | `authz.js` |

## Presentability, tests and repo

| # | Fix |
|---|---|
| 23-27 | New interface: no `alert()` or page reloads, toasts, live seat bars, responsive down to phone width, dates and venues shown, "null" descriptions gone, draft/publish/close/reopen, datetime picker |
| 28 | Seed data: six realistic events including a sold-out one with a waitlist demo, a closed one and a draft |
| 29 | Complete README, demo script |
| 30 | `npm test` runs everything; tests clean up after themselves (`npm run test:clean`) |
| 31 | Session `touch` disabled to cut a database write per request; documented as a benchmark factor |
| 32 | `migrate` refuses to touch an existing database without `--reset` |
| 33 | `docker-compose.yml` on port 5433; README troubleshooting for the port clash |

## How we know the tests are real

Besides passing, they fail when the code is wrong. We broke the real implementation on purpose:

| Deliberate break | Test that failed |
|---|---|
| Removed the row lock | `scale.js` |
| Disabled waitlist promotion | `cancel-vs-book.js`, `waitlist.js` |
| Removed the booking-limit check | `limit.js` |
| Naive check-then-write | `scale.js naive` shows 500 bookings for 100 seats |

## One thing to do on your side

- Change the database password that was in the old `.env.example`, and make sure `.env` was never committed to GitHub.
