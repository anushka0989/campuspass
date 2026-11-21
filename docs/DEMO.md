# Demo script (about 6 minutes)

## Before you present

1. `docker compose up -d`, then `npm run db:reset` (fresh demo data), then `npm run dev`.
2. Open two browser windows side by side: one for a student (use a normal window), one for the organizer (use a private window so the sessions do not mix).
3. Log in: student window as `stu3@test.com`, organizer window as `org@test.com`, both with `password123`.
4. Have a second terminal ready in the project folder.
5. Run `npm run test:bench` once beforehand so `docs/benchmark-latest.md` has numbers from this laptop.

## The story

**1. The promise (30 seconds).** "If the app says a seat is available, booking it gets you in. The hard part is when hundreds of students click at the same moment."

**2. Browse and book (1 minute).** Student window: show the events, the live seat bars, a closed event and a sold-out one. Book *Open Mic Night*. Open *My tickets* and show the QR code.

**3. The last seat (1 minute).** Organizer window: the dashboard for *Last Seat Demo* (1 seat). Student window: book it. Say what would happen without locking: two students could both be told yes.

**4. Waitlist and fair promotion (1 minute).** *Full-Stack Workshop* is sold out. As `stu3`, click *Join waitlist* and show "number 1". In the organizer window open that event and cancel `stu1`'s booking (click twice to confirm). Watch the dashboard: the seat goes straight to `stu3`, the waitlist drops to 0, and the green reconciliation line stays true. Student window: the ticket appears under *My tickets*.

**5. Check-in (1 minute).** Organizer dashboard: click *Check in* next to a student, or use the Check-in page and paste the code from the ticket's "Show check-in code". Scan the same code again to show it is refused as already used.

**5b. Organizer controls (optional, 1 minute).** On the dashboard, change the seat count, book a seat for a student by email, switch the event to atomic locking, or turn on approval and show a booking arrive as *Awaiting approval*, then click Approve.

**6. The proof (1.5 minutes).** In the terminal:

```bash
npm run test:naive     # the broken version: 500 bookings for 100 seats
npm run test:scale     # the real one: exactly 100 x 201, 400 x 409, zero 500s, reconciled
```

Then open `docs/benchmark-latest.md` and show the comparison of the two mechanisms (row lock against atomic update): throughput and p50/p95 latency over repeated runs.

## Likely questions

- **Why not just check the count in the application?** Between the check and the write another request can run. The check and the write must be one indivisible step: a lock or a conditional update.
- **Why two mechanisms?** To compare them. The row lock is easy to reason about; the atomic update needs fewer round trips. The benchmark shows the difference on this hardware.
- **What stops a deadlock?** Every transaction takes locks in the same order: event, booking, student.
- **How do you know the tests can catch a bug?** The naive version fails them, and the real implementations pass. We also broke the real code on purpose (removed the lock, disabled promotion, removed the limit) and the matching test failed each time.
- **Counter or rows, which is the truth?** Both, and they must agree. A database view computes the difference, the dashboard shows it, and every test asserts it.
- **What did you leave out?** Payments, notifications, seat maps and multi-seat bookings, deliberately (see SCOPE.md section 4).
- **What would you do with more time?** Shard the counter for a very hot event, add email notifications, and expire ticket codes.

## If something goes wrong on the day

- Tables missing or odd data: `npm run db:reset`.
- Port 3000 busy: change `PORT` in `.env` and restart.
- Database down: `docker compose up -d`.
