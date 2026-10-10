// Create (or reset) the ONE shared restaurant login that can pick any restaurant after login.
//   node add-portal-user.js restaurants@multieats.test "Your@StrongPass9"
// Non-destructive: works on the existing local DB or on Neon (set DATABASE_URL for this one command only).
require('dotenv').config();
const bcrypt = require('bcryptjs'), { Client } = require('pg'), { passwordProblem } = require('./validators');
const [email, password] = process.argv.slice(2);
if (!email || !password) { console.error('Usage: node add-portal-user.js email password'); process.exit(1); }
const weak = passwordProblem(password, { email });
if (weak) { console.error(weak); process.exit(1); }
(async () => {
  const c = new Client(process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
    : { user: process.env.DB_USER, password: process.env.DB_PASSWORD, host: process.env.DB_HOST || 'localhost',
        port: process.env.DB_PORT || 5432, database: process.env.DB_NAME || 'food_delivery' });
  await c.connect();
  const r = await c.query('SELECT sp_create_portal_user($1,$2,$3) AS u', ['MultiEats Restaurant Panel', email, await bcrypt.hash(password, 10)]);
  console.log('Shared restaurant login ready:', r.rows[0].u.email, '(select a restaurant after login)');
  await c.end();
})().catch(e => { console.error('Failed:', e.message); process.exit(1); });
