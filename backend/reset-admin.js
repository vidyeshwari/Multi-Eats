require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query('SELECT sp_create_platform_admin($1,$2,$3)',
    ['MultiEats Main Admin', 'restaurant@multieats.test', await bcrypt.hash(process.env.NEWPW, 10)]);
  console.log('Admin password updated');
  await c.end();
})();