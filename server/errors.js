// One error contract for the whole API:  { "error": { "code": "SOLD_OUT", "message": "..." } }

const STATUS = {
  BAD_INPUT: 400,
  UNAUTHENTICATED: 401,
  BAD_CREDS: 401,
  BAD_TOKEN: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  BOOKINGS_CLOSED: 422,
  TOO_MANY_ATTEMPTS: 429,
  INTERNAL: 500,
  // everything else is a state conflict
};

const MESSAGES = {
  UNAUTHENTICATED: 'Log in to continue.',
  BAD_CREDS: 'Wrong email or password.',
  FORBIDDEN: 'You do not have access to this.',
  NOT_FOUND: 'Not found.',
  SOLD_OUT: 'This event is sold out.',
  ALREADY_BOOKED: 'You already have a seat for this event.',
  BOOKINGS_CLOSED: 'Bookings for this event are closed.',
  BOOKING_LIMIT_REACHED: 'You have reached the limit of upcoming bookings. Cancel one to book another.',
  SEATS_AVAILABLE: 'Seats are still available - book one instead of joining the waitlist.',
  ALREADY_WAITLISTED: 'You are already on the waitlist.',
  INVALID_STATE: 'That booking is not in a state that allows this.',
  ALREADY_CHECKED_IN: 'This ticket was already used.',
  CANCELLED: 'This ticket was cancelled.',
  EMAIL_TAKEN: 'An account with this email already exists.',
  BAD_TOKEN: 'This QR code is not valid.',
  TOO_MANY_ATTEMPTS: 'Too many failed logins. Try again in a few minutes.',
  CAPACITY_BELOW_BOOKED: 'Capacity cannot be lower than the seats already booked.',
  STUDENT_NOT_FOUND: 'No student account with that email.',
  INTERNAL: 'Something went wrong on our side. Try again.',
};

function sendError(res, code, message) {
  const status = STATUS[code] || 409;
  res.status(status).json({ error: { code, message: message || MESSAGES[code] || code } });
}

module.exports = { sendError, STATUS, MESSAGES };
