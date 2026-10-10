// Applies database/v3_fixes.sql to an EXISTING database (local or Neon). Safe to run many times: it only uses
// CREATE OR REPLACE FUNCTION and never drops or deletes data.   Usage (from the backend folder):  npm run apply-patch
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config();
const fs = require('fs'), { Client } = require('pg');
const file = process.argv[2] || 'v3_fixes.sql';
const c = new Client(process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
  : { user: process.env.DB_USER, password: process.env.DB_PASSWORD, host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432, database: process.env.DB_NAME || 'food_delivery' });
(async () => {
  await c.connect();
  await c.query(fs.readFileSync(path.join(__dirname, '..', 'database', file), 'utf8'));
  console.log('Applied', file);
  await c.end();
})().catch(e => { console.error('Patch failed:', e.message); process.exit(1); });
