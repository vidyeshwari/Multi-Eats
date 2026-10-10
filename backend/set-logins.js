const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const bcrypt = require('bcryptjs'), { Client } = require('pg');
const ADMIN_EMAIL = 'admin@multieats.test', REST_EMAIL = 'restaurant@multieats.test';
const adminPw = process.env.ADMIN_PW || 'admin123', restPw = process.env.RESTAURANT_PW || 'restaurant123';
const c = new Client(process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
  : { user: process.env.DB_USER, password: process.env.DB_PASSWORD, host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432, database: process.env.DB_NAME || 'food_delivery' });
(async () => {
  await c.connect();
  await c.query('SELECT sp_create_platform_admin($1,$2,$3)', ['MultiEats Main Admin', ADMIN_EMAIL, await bcrypt.hash(adminPw, 10)]);
  await c.query('SELECT sp_create_portal_user($1,$2,$3)', ['MultiEats Restaurant Panel', REST_EMAIL, await bcrypt.hash(restPw, 10)]);
  await c.query('UPDATE Users SET can_switch_restaurant = FALSE WHERE email = $1', [ADMIN_EMAIL]);
  const r = await c.query('SELECT email, role, is_platform_admin, can_switch_restaurant FROM Users WHERE email = ANY($1) ORDER BY email', [[ADMIN_EMAIL, REST_EMAIL]]);
  console.table(r.rows);
  console.log(`Main admin       : ${ADMIN_EMAIL} / ${adminPw}\nRestaurant panel : ${REST_EMAIL} / ${restPw}`);
  await c.end();
})().catch(e => { console.error('Failed:', e.message); process.exit(1); });