-- ============================================================
-- CampusPass database schema (PostgreSQL 15+)
--
-- Invariant the whole system protects:
--   events.seats_left + (pending + confirmed + checked_in bookings) = events.total_seats
--   and seats_left can never be negative.
--
-- This file DROPS and recreates every table. Run it through
--   npm run migrate -- --reset
-- ============================================================

DROP VIEW  IF EXISTS event_reconciliation;
DROP TABLE IF EXISTS waitlist CASCADE;
DROP TABLE IF EXISTS bookings CASCADE;
DROP TABLE IF EXISTS events   CASCADE;
DROP TABLE IF EXISTS users    CASCADE;

-- 1. USERS
CREATE TABLE users (
    id            BIGSERIAL PRIMARY KEY,
    email         VARCHAR(255) NOT NULL UNIQUE,
    password_hash TEXT         NOT NULL,
    role          VARCHAR(20)  NOT NULL CHECK (role IN ('student', 'organizer')),
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- 2. EVENTS
--    status: draft  = only the organizer sees it
--            open   = visible and bookable
--            closed = visible, bookings stopped (manual closure)
CREATE TABLE events (
    id           BIGSERIAL PRIMARY KEY,
    organizer_id BIGINT       NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    title        VARCHAR(200) NOT NULL,
    description  TEXT,
    venue        VARCHAR(200),
    starts_at    TIMESTAMPTZ  NOT NULL,
    total_seats  INT          NOT NULL CHECK (total_seats > 0),
    seats_left   INT          NOT NULL,
    status       VARCHAR(10)  NOT NULL DEFAULT 'open' CHECK (status IN ('draft', 'open', 'closed')),
    lock_mode    VARCHAR(10)  NOT NULL DEFAULT 'rowlock' CHECK (lock_mode IN ('rowlock', 'atomic')),
    requires_approval BOOLEAN NOT NULL DEFAULT FALSE,   -- organizer must approve each booking
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CHECK (seats_left >= 0),                 -- last line of defence: never negative
    CHECK (seats_left <= total_seats)
);

-- 3. BOOKINGS (one row = exactly one seat)
CREATE TABLE bookings (
    id            BIGSERIAL PRIMARY KEY,
    event_id      BIGINT      NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
    student_id    BIGINT      NOT NULL REFERENCES users(id)  ON DELETE RESTRICT,
    status        VARCHAR(20) NOT NULL DEFAULT 'confirmed'
                  CHECK (status IN ('pending', 'confirmed', 'cancelled', 'checked_in')),
    qr_token      TEXT UNIQUE,                -- HMAC-signed, see server/bookingService.js
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cancelled_at  TIMESTAMPTZ,
    checked_in_at TIMESTAMPTZ
);

-- A student can hold at most one active seat per event.
CREATE UNIQUE INDEX bookings_one_active_per_student_event
    ON bookings (event_id, student_id)
    WHERE status IN ('pending', 'confirmed', 'checked_in');

-- 4. WAITLIST (first come, first served: ordered by id)
CREATE TABLE waitlist (
    id         BIGSERIAL PRIMARY KEY,
    event_id   BIGINT      NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
    student_id BIGINT      NOT NULL REFERENCES users(id)  ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (event_id, student_id)
);

-- 5. INDEXES
CREATE INDEX idx_events_starts_at       ON events (starts_at);
CREATE INDEX idx_events_organizer       ON events (organizer_id);
CREATE INDEX idx_bookings_event_status  ON bookings (event_id, status);
CREATE INDEX idx_bookings_student       ON bookings (student_id, status);
CREATE INDEX idx_waitlist_event_order   ON waitlist (event_id, id);

-- 6. RECONCILIATION VIEW: does the counter agree with the rows?
CREATE VIEW event_reconciliation AS
SELECT e.id,
       e.total_seats,
       e.seats_left,
       COUNT(b.id) FILTER (WHERE b.status IN ('pending', 'confirmed', 'checked_in'))::int AS active_bookings,
       (e.seats_left + COUNT(b.id) FILTER (WHERE b.status IN ('pending', 'confirmed', 'checked_in')) = e.total_seats) AS ok
FROM events e
LEFT JOIN bookings b ON b.event_id = e.id
GROUP BY e.id;