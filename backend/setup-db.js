// One-command DB setup: creates the database (if missing), runs schema.sql + seed.sql
require('dotenv').config();
const bcrypt = require('bcryptjs');
const fs = require('fs'), path = require('path'), { Client } = require('pg');
const cfg = { user: process.env.DB_USER, password: process.env.DB_PASSWORD, host: process.env.DB_HOST || 'localhost', port: process.env.DB_PORT || 5432 };
const dbName = process.env.DB_NAME || 'food_delivery';
const useUrl = !!process.env.DATABASE_URL;
(async () => {
  if (!useUrl) {
    const admin = new Client({ ...cfg, database: 'postgres' });
    await admin.connect();
    const ex = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [dbName]);
    if (!ex.rowCount) { await admin.query(`CREATE DATABASE "${dbName}"`); console.log('Created database', dbName); }
    await admin.end();
  }
  if (useUrl && process.env.ALLOW_WIPE !== 'yes') {
    console.error('Refusing to wipe the cloud database. Set ALLOW_WIPE=yes only if you really want this.');
    process.exit(1);
  }
  const c = new Client(useUrl
    ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
    : { ...cfg, database: dbName });
  await c.connect();
  for (const f of ['schema.sql', 'procedures.sql', 'seed.sql', 'v2_upgrade.sql', 'v3_fixes.sql']) {
    await c.query(fs.readFileSync(path.join(__dirname, '..', 'database', f), 'utf8'));
    console.log('Ran', f);
  }
  // Idempotent photo_url fallback for fresh DBs
  await c.query("UPDATE Restaurants SET photo_url = 'images/r' || restaurant_id || '.jpg' WHERE photo_url IS NULL");

  // demo restaurant login (customers sign up on the site; restaurant accounts are only created here / by add-restaurant-user.js)
  const email = process.env.RESTAURANT_EMAIL || 'restaurant@multieats.test', pw = process.env.RESTAURANT_PASSWORD || 'restaurant123';
  await c.query('SELECT sp_create_platform_admin($1,$2,$3)', ['MultiEats Main Admin', email, await bcrypt.hash(pw, 10)]);
  console.log('Main admin login:', email, '/', pw, '(change it in .env before the demo goes public)');
  // ONE shared restaurant login: it picks a restaurant after login and then only sees that restaurant's panel
  const pEmail = process.env.PORTAL_EMAIL || 'restaurants@multieats.test', pPw = process.env.PORTAL_PASSWORD || 'Rest@urant#Panel9';
  await c.query('SELECT sp_create_portal_user($1,$2,$3)', ['MultiEats Restaurant Panel', pEmail, await bcrypt.hash(pPw, 10)]);
  console.log('Restaurant panel login (select restaurant after login):', pEmail, '/', pPw);
  const r = await c.query('SELECT (SELECT COUNT(*) FROM Restaurants) r, (SELECT COUNT(*) FROM MenuItems) m, (SELECT COUNT(*) FROM DeliveryPartners) d');
  console.log('Restaurants:', r.rows[0].r, '| Menu items:', r.rows[0].m, '| Partners:', r.rows[0].d);
  await c.end();
})().catch(e => { console.error('Setup failed:', e.message); process.exit(1); });
