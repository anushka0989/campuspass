require('dotenv').config();

const isProd = process.env.NODE_ENV === 'production';

function secret(name, devFallback) {
  const value = process.env[name];
  if (value) return value;
  if (isProd) throw new Error(`${name} must be set when NODE_ENV=production`);
  console.warn(`[config] ${name} is not set - using an insecure development default`);
  return devFallback;
}

module.exports = {
  isProd,
  port: Number(process.env.PORT) || 3000,
  sessionSecret: secret('SESSION_SECRET', 'dev-session-secret'),
  hmacSecret: secret('HMAC_SECRET', 'dev-hmac-secret'),
  // Organizers can only self-register with this code. Empty = organizer sign-up disabled.
  organizerCode: process.env.ORGANIZER_CODE || '',
  // Per-student limit on upcoming confirmed bookings (across all events).
  maxActiveBookings: Number(process.env.MAX_ACTIVE_BOOKINGS) || 3,
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS) || 10,
  // ?strategy=naive exists only to demonstrate the race condition; never in production.
  allowNaive: !isProd,
};
