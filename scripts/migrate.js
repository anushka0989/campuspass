require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// Applies db/schema.sql. The schema DROPS all tables, so an existing database needs --reset.
(async () => {
  const reset = process.argv.includes('--reset');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const existing = await pool.query(`SELECT to_regclass('public.users') AS t`);
    if (existing.rows[0].t && !reset) {
      console.error('The database already has CampusPass tables. Nothing was changed.');
      console.error('To wipe it and start fresh run:  npm run migrate -- --reset');
      process.exitCode = 1;
      return;
    }
    if (reset) await pool.query('DROP TABLE IF EXISTS session CASCADE'); // sessions point at deleted users
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
    await pool.query(sql);
    console.log('Schema applied: users, events, bookings, waitlist, event_reconciliation.');
  } catch (error) {
    console.error('Migration failed:', error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
