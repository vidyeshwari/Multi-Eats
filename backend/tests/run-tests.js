// MultiEats automated test runner  ->  npm test   (from the project root or from backend/)
// Starts the real server on a spare port, runs Standard (ST), Edge (ET), Functional (FT) and Non-functional (NFT)
// tests against the LOCAL PostgreSQL database, prints a table and writes ../TEST_REPORT.md (with the Actual Result of each test).
// Test data is prefixed "zz_" and is deleted at the end. It refuses to run against a cloud DATABASE_URL.
const path = require('path'), fs = require('fs'), crypto = require('crypto'), { spawn } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const bcrypt = require('bcryptjs'), { Pool } = require('pg');
const { phoneProblem, passwordProblem } = require('../validators');

if (process.env.DATABASE_URL && process.env.ALLOW_TESTS_ON_CLOUD !== 'yes') {
  console.error('Refusing to run tests: DATABASE_URL (cloud database) is set. Comment it out in backend/.env and use the local database.');
  process.exit(1);
}
const ROOT = path.join(__dirname, '..', '..'), BACKEND = path.join(__dirname, '..');
const PORT = 5055, BASE = `http://127.0.0.1:${PORT}`, SECRET = 'test-secret-' + crypto.randomBytes(8).toString('hex');
const pool = new Pool({ user: process.env.DB_USER, password: process.env.DB_PASSWORD, host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432, database: process.env.DB_NAME || 'food_delivery' });
const q = (sql, p) => pool.query(sql, p);
const rnd = () => crypto.randomBytes(4).toString('hex');
const PW = 'Zx9$kLm2!pQw';
const mkEmail = p => `zz_${p}_${rnd()}@test.com`.toLowerCase();
const mkPhone = () => '9' + String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
const S = {};                                        // shared fixtures
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- tiny helpers ----------
async function http(method, p, { token, body, raw, headers, signal, base } = {}) {
  const h = { ...(headers || {}) }; if (token) h.Authorization = 'Bearer ' + token;
  let b; if (raw !== undefined) { b = raw; h['Content-Type'] = h['Content-Type'] || 'application/json'; }
  else if (body !== undefined) { b = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  const r = await fetch((base || BASE) + p, { method, headers: h, body: b, signal });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, headers: r.headers };
}
const GET = (p, o) => http('GET', p, o), POST = (p, body, o) => http('POST', p, { ...o, body }), PATCH = (p, body, o) => http('PATCH', p, { ...o, body });
const check = (c, m) => { if (!c) throw new Error(m); };
const err = r => (r.json && r.json.error) || r.text.slice(0, 80);
const dbErr = async (sql, p) => { try { await q(sql, p); } catch (e) { return e; } throw new Error('Database accepted the statement (it should have been rejected)'); };
const first = s => String(s).split('\n')[0];

async function startServer(port, extraEnv = {}) {
  const env = { ...process.env, PORT: String(port), AUTH_SECRET: SECRET, ...extraEnv };
  if (extraEnv.__noUrl) delete env.DATABASE_URL; delete env.__noUrl;
  const child = spawn(process.execPath, ['server.js'], { cwd: BACKEND, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.out = ''; child.stdout.on('data', d => child.out += d); child.stderr.on('data', d => child.out += d);
  for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${port}/health`); return child; } catch { await sleep(150); } }
  throw new Error('Server did not start: ' + child.out.slice(0, 200));
}
const login = async (email, pw = PW) => { const r = await POST('/auth/login', { email, password: pw }); check(r.status === 200, `login failed (${r.status} ${err(r)})`); return r.json; };
async function newCustomer(tag = 'cust') {
  const email = mkEmail(tag), phone = mkPhone();
  const r = await POST('/auth/signup', { name: 'Zz Customer', email, password: PW, phone });
  check(r.status === 200, `signup failed (${r.status} ${err(r)})`);
  const l = await login(email); return { email, phone, token: l.token, id: l.user.user_id };
}
async function placeOrder(token, items) {
  const r = await POST('/orders', { delivery_address: 'zz test address', delivery_lat: S.lat, delivery_lng: S.lng,
    items: items || [{ item_id: S.iA, quantity: 1 }, { item_id: S.iB, quantity: 2 }] }, { token });
  check(r.status === 200, `order failed (${r.status} ${err(r)})`);
  const subs = (await q('SELECT sub_order_id, restaurant_id FROM SubOrders WHERE order_id=$1 ORDER BY sub_order_id', [r.json.order_id])).rows;
  return { id: r.json.order_id, subA: subs.find(s => s.restaurant_id === S.A).sub_order_id, subB: subs.find(s => s.restaurant_id === S.B).sub_order_id, total: r.json.total };
}
const setting = async (token, rid) => { const r = await POST('/portal/select', { restaurant_id: rid }, { token }); check(r.status === 200, `select failed ${r.status}`); };
const stl = async (sub) => (await q('SELECT * FROM Settlements WHERE sub_order_id=$1', [sub])).rows[0];
const signToken = (uid, exp) => { const b = Buffer.from(JSON.stringify({ uid, exp })).toString('base64url');
  return `${b}.${crypto.createHmac('sha256', SECRET).update(b).digest('base64url')}`; };

// ---------- test registry ----------
const tests = [];
const T = (id, group, scenario, expected, run, opts = {}) => tests.push({ id, group, scenario, expected, run, ...opts });

async function cleanup() {
  const u = `SELECT user_id FROM Users WHERE email LIKE 'zz\\_%@test.com'`;
  const parts = (await q(`SELECT DISTINCT da.partner_id FROM DeliveryAssignment da JOIN Orders o ON o.order_id=da.order_id WHERE o.user_id IN (${u})`)).rows.map(r => r.partner_id);
  await q(`DELETE FROM Refunds WHERE sub_order_id IN (SELECT so.sub_order_id FROM SubOrders so JOIN Orders o ON o.order_id=so.order_id WHERE o.user_id IN (${u}))`);
  await q(`DELETE FROM Orders WHERE user_id IN (${u})`);
  if (parts.length) await q('UPDATE DeliveryPartners SET is_available=TRUE WHERE partner_id = ANY($1)', [parts]);
  await q(`DELETE FROM MenuItems WHERE name LIKE 'zz\\_%'`);
  await q(`DELETE FROM Users WHERE email LIKE 'zz\\_%@test.com'`);
}
async function setup() {
  await cleanup();
  const h = await bcrypt.hash(PW, 10);
  S.adminEmail = mkEmail('admin'); await q('SELECT sp_create_platform_admin($1,$2,$3)', ['zz Admin', S.adminEmail, h]);
  S.portalEmail = mkEmail('portal'); await q('SELECT sp_create_portal_user($1,$2,$3)', ['zz Portal', S.portalEmail, h]);
  const r = (await q(`SELECT r1.restaurant_id a, r2.restaurant_id b, r1.lat, r1.lng FROM Restaurants r1
      JOIN Restaurants r2 ON r2.restaurant_id>r1.restaurant_id AND haversine_km(r1.lat,r1.lng,r2.lat,r2.lng)<2
     WHERE r1.is_active AND r2.is_active
       AND EXISTS (SELECT 1 FROM MenuItems m WHERE m.restaurant_id=r1.restaurant_id AND m.is_available)
       AND EXISTS (SELECT 1 FROM MenuItems m WHERE m.restaurant_id=r2.restaurant_id AND m.is_available) ORDER BY 1,2 LIMIT 1`)).rows[0];
  if (!r) throw new Error('No two restaurants within 2 km found. Run: npm run setup-db');
  Object.assign(S, { A: r.a, B: r.b, lat: r.lat, lng: r.lng });
  const item = async rid => (await q('SELECT item_id FROM MenuItems WHERE restaurant_id=$1 AND is_available ORDER BY item_id LIMIT 1', [rid])).rows[0].item_id;
  S.iA = await item(S.A); S.iB = await item(S.B);
  S.C = (await q('SELECT restaurant_id FROM Restaurants WHERE restaurant_id NOT IN ($1,$2) ORDER BY restaurant_id LIMIT 1', [S.A, S.B])).rows[0].restaurant_id;
  S.nameA = (await q('SELECT name FROM Restaurants WHERE restaurant_id=$1', [S.A])).rows[0].name;
  S.nameB = (await q('SELECT name FROM Restaurants WHERE restaurant_id=$1', [S.B])).rows[0].name;
  S.ownerAEmail = mkEmail('ownerA'); await q('SELECT sp_create_restaurant_user($1,$2,$3,$4)', ['zz OwnerA', S.ownerAEmail, h, S.A]);
  S.ownerBEmail = mkEmail('ownerB'); await q('SELECT sp_create_restaurant_user($1,$2,$3,$4)', ['zz OwnerB', S.ownerBEmail, h, S.B]);
  S.admin = (await login(S.adminEmail)).token; S.ownerA = (await login(S.ownerAEmail)).token; S.ownerB = (await login(S.ownerBEmail)).token;
  S.portal = (await login(S.portalEmail)).token;
  S.cust = await newCustomer('cust1');
}

// =====================================================================================================
// 20. STANDARD / COMPULSORY (ST)
// =====================================================================================================
T('ST-01', 'Standard', 'Application launches', 'Application opens', async () => {
  const r = await GET('/'); check(r.status === 200 && /MultiEats/i.test(r.text), `HTTP ${r.status}`);
  const h = await GET('/health'); check(h.status === 200, 'health ' + h.status);
  return `HTTP 200, home page served; /health -> server ${h.json.server}, database ${h.json.database}`;
});
T('ST-02', 'Standard', 'Login: valid login', 'Login successful', async () => {
  const r = await POST('/auth/login', { email: S.adminEmail, password: PW });
  check(r.status === 200 && r.json.token && r.json.user.role === 'admin', `HTTP ${r.status}`);
  return `HTTP 200, token issued, role=${r.json.user.role}`;
});
T('ST-03', 'Standard', 'Login: invalid password', 'Login rejected', async () => {
  const r = await POST('/auth/login', { email: S.adminEmail, password: 'Wrong@Pass1' });
  check(r.status === 401 && !r.json.token, `HTTP ${r.status}`); return `HTTP 401 "${err(r)}", no token`;
});
T('ST-04', 'Standard', 'Input: empty mandatory field', 'Validation error', async () => {
  const r = await POST('/auth/signup', { name: '', email: '', password: '', phone: '' });
  check(r.status === 400, `HTTP ${r.status}`); return `HTTP 400 "${err(r)}"`;
});
T('ST-05', 'Standard', 'CREATE: add valid record (menu item)', 'Record inserted', async () => {
  await setting(S.portal, S.A);
  const r = await POST('/admin/menu-items', { name: 'zz_item_' + rnd(), category: 'Test', price: 99, is_veg: true }, { token: S.portal });
  check(r.status === 200, `HTTP ${r.status} ${err(r)}`); S.menuId = r.json.item_id;
  const db = (await q('SELECT name, price, restaurant_id FROM MenuItems WHERE item_id=$1', [S.menuId])).rows[0];
  check(db && +db.price === 99 && db.restaurant_id === S.A, 'row not found in PostgreSQL');
  return `HTTP 200; PostgreSQL row item_id=${S.menuId}, price=${db.price}, restaurant_id=${db.restaurant_id}`;
});
T('ST-06', 'Standard', 'READ: view records', 'Correct records displayed', async () => {
  const r = await GET('/restaurants'); const n = (await q('SELECT COUNT(*)::int c FROM Restaurants WHERE is_active')).rows[0].c;
  check(r.status === 200 && Array.isArray(r.json) && r.json.length === n, `API ${r.json && r.json.length} vs DB ${n}`);
  return `HTTP 200, ${r.json.length} restaurants returned = ${n} active rows in PostgreSQL`;
});
T('ST-07', 'Standard', 'Search: search existing record', 'Correct record displayed', async () => {
  const term = S.nameA.split(' ')[0].toLowerCase(), r = await GET('/restaurants');
  const api = r.json.filter(x => (x.name + ' ' + x.cuisine_type + ' ' + x.area).toLowerCase().includes(term)).map(x => x.restaurant_id).sort();
  const db = (await q(`SELECT restaurant_id FROM Restaurants WHERE is_active AND (name||' '||cuisine_type||' '||COALESCE(area,'')) ILIKE $1 ORDER BY 1`, ['%' + term + '%'])).rows.map(x => x.restaurant_id);
  check(api.includes(S.A) && JSON.stringify(api) === JSON.stringify(db), 'search result differs from database');
  return `Search "${term}": ${api.length} result(s), identical to PostgreSQL ILIKE search; includes "${S.nameA}"`;
});
T('ST-08', 'Standard', 'UPDATE: update record (menu price)', 'Record updated', async () => {
  const r = await PATCH('/admin/menu-items/' + S.menuId, { price: 123 }, { token: S.portal });
  check(r.status === 200, `HTTP ${r.status} ${err(r)}`);
  const db = (await q('SELECT price FROM MenuItems WHERE item_id=$1', [S.menuId])).rows[0];
  check(+db.price === 123, 'price not updated'); return `HTTP 200; PostgreSQL price is now ${db.price}`;
});
T('ST-09', 'Standard', 'DELETE: delete record (menu item)', 'Record deleted', async () => {
  const r = await http('DELETE', '/admin/menu-items/' + S.menuId, { token: S.portal });
  check(r.status === 200, `HTTP ${r.status} ${err(r)}`);
  const n = (await q('SELECT COUNT(*)::int c FROM MenuItems WHERE item_id=$1', [S.menuId])).rows[0].c;
  check(n === 0, 'row still exists'); return `HTTP 200; SELECT returns ${n} rows for item_id=${S.menuId}`;
});
T('ST-10', 'Standard', 'PK: duplicate primary key', 'Rejected', async () => {
  const id = (await q('SELECT MIN(user_id) m FROM Users')).rows[0].m;
  const e = await dbErr(`INSERT INTO Users(user_id,name,email,password_hash,phone) VALUES ($1,'Dup',$2,'x','9876543210')`, [id, mkEmail('pk')]);
  check(e.code === '23505', e.code); return `Rejected (${e.code}): ${e.message}`;
});
T('ST-11', 'Standard', 'NOT NULL: NULL mandatory field', 'Rejected', async () => {
  const e = await dbErr(`INSERT INTO Users(name,email,password_hash,phone) VALUES (NULL,$1,'x','9876543210')`, [mkEmail('nn')]);
  check(e.code === '23502', e.code); return `Rejected (${e.code}): ${e.message}`;
});
T('ST-12', 'Standard', 'UNIQUE: duplicate unique value (email)', 'Rejected', async () => {
  const e = await dbErr(`INSERT INTO Users(name,email,password_hash,phone) VALUES ('Dup',$1,'x','9876543210')`, [S.adminEmail]);
  check(e.code === '23505', e.code); return `Rejected (${e.code}): ${e.message}`;
});
T('ST-13', 'Standard', 'FK: invalid foreign key', 'Rejected', async () => {
  const e = await dbErr(`INSERT INTO MenuItems(restaurant_id,name,price) VALUES (99999999,'zz_fk',10)`);
  check(e.code === '23503', e.code); return `Rejected (${e.code}): ${e.message}`;
});
T('ST-14', 'Standard', 'JOIN: execute JOIN', 'Correct result', async () => {
  const j = (await q(`SELECT COUNT(*)::int c FROM Orders o JOIN Users u ON u.user_id=o.user_id JOIN SubOrders so ON so.order_id=o.order_id JOIN Restaurants r ON r.restaurant_id=so.restaurant_id`)).rows[0].c;
  const s = (await q('SELECT COUNT(*)::int c FROM SubOrders')).rows[0].c; check(j === s, `${j} vs ${s}`);
  return `4-table JOIN (Orders-Users-SubOrders-Restaurants) returned ${j} rows = ${s} sub-orders`;
});
T('ST-15', 'Standard', 'Aggregate: execute aggregate', 'Correct result', async () => {
  const a = (await q(`SELECT COALESCE(SUM(t.s),0) s FROM (SELECT SUM(sub_amount) s FROM SubOrders GROUP BY restaurant_id) t`)).rows[0].s;
  const b = (await q('SELECT COALESCE(SUM(sub_amount),0) s FROM SubOrders')).rows[0].s; check(+a === +b, `${a} vs ${b}`);
  return `SUM per restaurant (GROUP BY) added together = ${a} = overall SUM ${b}`;
});
T('ST-16', 'Standard', 'View: execute view', 'Correct result', async () => {
  const v = (await q('SELECT COUNT(*)::int c FROM vw_order_summary')).rows[0].c, s = (await q('SELECT COUNT(*)::int c FROM SubOrders')).rows[0].c;
  check(v === s, `${v} vs ${s}`); return `vw_order_summary returned ${v} rows = ${s} sub-orders`;
});
T('ST-17', 'Standard', 'Integration: Frontend -> Backend', 'Request processed', async () => {
  const o = await placeOrder(S.cust.token); S.O0 = o;
  return `POST /orders with Authorization header -> HTTP 200, order #${o.id} created, total ${o.total}`;
});
T('ST-18', 'Standard', 'Integration: Backend -> PostgreSQL (MySQL in sheet)', 'Correct operation', async () => {
  const r = await POST('/auth/signup', { name: 'Zz Backend', email: mkEmail('be'), password: PW, phone: mkPhone() });
  check(r.status === 200, `HTTP ${r.status}`);
  const n = (await q('SELECT COUNT(*)::int c FROM Users WHERE user_id=$1', [r.json.user.user_id])).rows[0].c; check(n === 1, 'row missing');
  return `Signup via API -> HTTP 200 and the user row (id ${r.json.user.user_id}) exists in PostgreSQL`;
});
T('ST-19', 'Standard', 'Database: PostgreSQL (MySQL in sheet) -> Backend', 'Correct response', async () => {
  const nm = 'zz_db_' + rnd();
  await q('INSERT INTO MenuItems(restaurant_id,name,price) VALUES ($1,$2,55)', [S.A, nm]);
  const r = await GET('/restaurants/' + S.A); check(r.status === 200 && r.json.menu.some(m => m.name === nm), 'row inserted in DB not returned by API');
  return `Row inserted directly in PostgreSQL ("${nm}") is returned by GET /restaurants/${S.A}`;
});
T('ST-20', 'Standard', 'Error: backend unavailable', 'Error handled', async () => {
  const cjs = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'common.js'), 'utf8');
  check(/Cannot reach backend/.test(cjs), 'frontend has no handler');
  S.server.kill(); await sleep(400);
  let msg = ''; try { await fetch(BASE + '/health'); } catch (e) { msg = (e.cause && e.cause.code) || e.message; }
  check(msg, 'server still answered');
  return `Server stopped: request fails (${msg}); frontend api() catches it and shows "Cannot reach backend. Is npm start running?"`;
}, { late: 1 });

// =====================================================================================================
// 21. EDGE (ET)
// =====================================================================================================
T('ET-01', 'Edge', 'Empty input', 'Validation error', async () => {
  const r = await POST('/auth/signup', { name: '   ', email: '', password: '' }); check(r.status === 400, `HTTP ${r.status}`);
  const l = await POST('/auth/login', { email: '', password: '' }); check(l.status === 401, `login HTTP ${l.status}`);
  return `Blank signup -> 400 "${err(r)}"; blank login -> 401 "${err(l)}"`;
});
T('ET-02', 'Edge', 'Minimum value: price 0', 'Accepted', async () => {
  const r = await POST('/admin/menu-items', { name: 'zz_min_' + rnd(), price: 0 }, { token: S.portal }); check(r.status === 200, `HTTP ${r.status} ${err(r)}`);
  return `Price 0 -> HTTP 200 accepted (item_id ${r.json.item_id})`;
});
T('ET-03', 'Edge', 'Below minimum: price -1', 'Rejected', async () => {
  const r = await POST('/admin/menu-items', { name: 'zz_neg_' + rnd(), price: -1 }, { token: S.portal }); check(r.status === 400, `HTTP ${r.status}`);
  const e = await dbErr('INSERT INTO SubOrderItems(sub_order_id,item_id,quantity,price_at_order) VALUES (1,1,0,10)');
  return `Price -1 -> HTTP 400 "${err(r)}"; quantity 0 rejected by CHECK (${e.code})`;
});
T('ET-04', 'Edge', 'Maximum value: price 999999.99', 'Accepted', async () => {
  const r = await POST('/admin/menu-items', { name: 'zz_max_' + rnd(), price: 999999.99 }, { token: S.portal }); check(r.status === 200, `HTTP ${r.status} ${err(r)}`);
  return `HTTP 200, stored price ${r.json.price}`;
});
T('ET-05', 'Edge', 'Maximum + 1: price 1000000', 'Rejected/handled', async () => {
  const r = await POST('/admin/menu-items', { name: 'zz_max1_' + rnd(), price: 1000000 }, { token: S.portal }); check(r.status === 400, `HTTP ${r.status}`);
  return `HTTP 400 "${err(r)}" (numeric overflow handled, no crash)`;
});
T('ET-06', 'Edge', 'Duplicate record (same email twice)', 'Rejected', async () => {
  const email = mkEmail('dup'), b = { name: 'Zz Dup', email, password: PW, phone: mkPhone() };
  const a = await POST('/auth/signup', b), c = await POST('/auth/signup', b); check(a.status === 200 && c.status === 409, `${a.status}/${c.status}`);
  return `First signup 200, second signup 409 "${err(c)}"`;
});
T('ET-07', 'Edge', 'Special characters @#$%', 'Safely handled', async () => {
  const nm = '@#$% <b>x</b> & "q" \'s\'', email = mkEmail('sp');
  const r = await POST('/auth/signup', { name: nm, email, password: PW, phone: mkPhone() }); check(r.status === 200, `HTTP ${r.status} ${err(r)}`);
  const db = (await q('SELECT name FROM Users WHERE email=$1', [email])).rows[0].name; check(db === nm, 'stored text changed');
  const pages = ['owner.html', 'admin.html'].map(f => fs.readFileSync(path.join(ROOT, 'frontend', f), 'utf8')).join('');
  check(/esc\(o\.customer\)/.test(pages) && /esc\(x\.customer\)/.test(pages), 'UI does not escape names');
  return `Stored exactly as typed (parameterised SQL); pages print names through esc() so <b> is shown as text`;
});
T('ET-08', 'Edge', "SQL injection: ' OR 1=1 --", 'Rejected/safely handled', async () => {
  const before = (await q('SELECT COUNT(*)::int c FROM Users')).rows[0].c;
  const l = await POST('/auth/login', { email: "' OR 1=1 --", password: "' OR 1=1 --" }); check(l.status === 401 && !l.json.token, `login HTTP ${l.status}`);
  const l2 = await POST('/auth/login', { email: S.adminEmail, password: "x' OR '1'='1" }); check(l2.status === 401, `HTTP ${l2.status}`);
  const s = await POST('/auth/signup', { name: "x'); DROP TABLE Users;--", email: "a'--@x.com", password: PW, phone: mkPhone() });
  const g = await GET('/restaurants/1;DROP TABLE users'); const after = (await q('SELECT COUNT(*)::int c FROM Users')).rows[0].c;
  check(after === before + (s.status === 200 ? 1 : 0), 'user count changed unexpectedly'); check(g.status === 400, `path HTTP ${g.status}`);
  return `Login with injection -> 401 (no token); DROP TABLE text stored/rejected as plain data; Users table intact (${after} rows)`;
});
T('ET-09', 'Edge', 'Very large input', 'Handled correctly', async () => {
  const r = await POST('/auth/signup', { name: 'A'.repeat(5000), email: mkEmail('big'), password: PW, phone: mkPhone() }); check(r.status === 400, `HTTP ${r.status}`);
  const big = await http('POST', '/auth/login', { raw: JSON.stringify({ email: 'x@y.com', password: 'p'.repeat(300000) }) }); check(big.status === 413, `HTTP ${big.status}`);
  return `5000-char name -> 400 "${err(r)}"; 300 KB body -> 413 "${err(big)}"`;
});
T('ET-10', 'Edge', 'Non-existing record', 'Proper message', async () => {
  const a = await GET('/restaurants/99999999'); const b = await GET('/orders/99999999', { token: S.cust.token });
  check(a.status === 404 && b.status === 404, `${a.status}/${b.status}`); return `Restaurant 99999999 -> 404 "${err(a)}"; order 99999999 -> 404 "${err(b)}"`;
});
T('ET-11', 'Edge', 'PostgreSQL (MySQL in sheet) unavailable', 'Error handled', async () => {
  const c = await startServer(5056, { DB_PORT: '1', __noUrl: 1 });
  try {
    const h = await http('GET', '/health', { base: 'http://127.0.0.1:5056' }); const r = await http('GET', '/restaurants', { base: 'http://127.0.0.1:5056' });
    const h2 = await http('GET', '/health', { base: 'http://127.0.0.1:5056' });
    check(h.status === 503 && h.json.database === 'down' && r.status === 500 && r.json && r.json.error && h2.status === 503, `${h.status}/${r.status}/${h2.status}`);
    return `With the database unreachable: /health -> 503 {database:"down"}; /restaurants -> 500 JSON "${err(r)}"; server stayed alive`;
  } finally { c.kill(); }
});
T('ET-12', 'Edge', 'Backend unavailable', 'Error handled', async () => {
  let msg = ''; try { await fetch(BASE + '/restaurants'); } catch (e) { msg = (e.cause && e.cause.code) || e.message; }
  check(msg, 'server still answered'); return `Request while Node server is stopped fails with ${msg}; UI shows "Cannot reach backend"`;
}, { late: 2 });
T('ET-13', 'Edge', 'Invalid datatype', 'Rejected', async () => {
  const a = await GET('/restaurants/abc'); const b = await POST('/orders', { delivery_address: 'x', delivery_lat: 'north', delivery_lng: S.lng, items: [{ item_id: S.iA, quantity: 1 }] }, { token: S.cust.token });
  const c = await POST('/orders', { delivery_address: 'x', delivery_lat: S.lat, delivery_lng: S.lng, items: [{ item_id: 'abc', quantity: 'many' }] }, { token: S.cust.token });
  check(a.status === 400 && b.status === 400 && c.status === 400, `${a.status}/${b.status}/${c.status}`);
  return `id "abc" -> 400; lat "north" -> 400; item "abc" -> 400 (all "${err(a)}")`;
});
T('ET-14', 'Edge', 'Network interruption (request aborted mid-flight)', 'Error handled', async () => {
  const ac = new AbortController(); const p = GET('/restaurants', { signal: ac.signal }); ac.abort();
  let name = ''; try { await p; } catch (e) { name = e.name; } check(name === 'AbortError', 'request was not aborted');
  const h = await GET('/health'); check(h.status === 200, 'server unhealthy after abort');
  return `Client aborted the request (${name}); the server is still healthy afterwards (/health 200)`;
});
T('ET-15', 'Edge', 'Transaction failure', 'Rollback', async () => {
  const c0 = (await q('SELECT COUNT(*)::int c FROM Orders')).rows[0].c, s0 = (await q('SELECT COUNT(*)::int c FROM SubOrders')).rows[0].c;
  const r = await POST('/orders', { delivery_address: 'x', delivery_lat: S.lat, delivery_lng: S.lng, items: [{ item_id: S.iA, quantity: 1 }, { item_id: 99999999, quantity: 1 }] }, { token: S.cust.token });
  check(r.status === 400, `HTTP ${r.status}`);
  const cl = await pool.connect();
  try { await cl.query('BEGIN'); await cl.query(`INSERT INTO Orders(user_id,subtotal,delivery_fee,separate_fee_estimate,total_amount,delivery_lat,delivery_lng) VALUES ($1,1,1,1,2,18.5,73.8)`, [S.cust.id]);
    try { await cl.query(`INSERT INTO SubOrders(order_id,restaurant_id,sub_amount) VALUES (currval('orders_order_id_seq'),99999999,1)`); } catch {} await cl.query('ROLLBACK'); } finally { cl.release(); }
  const c1 = (await q('SELECT COUNT(*)::int c FROM Orders')).rows[0].c, s1 = (await q('SELECT COUNT(*)::int c FROM SubOrders')).rows[0].c;
  check(c0 === c1 && s0 === s1, 'partial rows remained');
  return `Order with one bad item -> 400, no order/sub-order saved; manual BEGIN..error..ROLLBACK also left counts unchanged (${c1} orders, ${s1} sub-orders)`;
});
// extra edge cases for the new rules
T('ET-16', 'Edge', 'Phone starts with 6 (10 digits)', 'Rejected', async () => {
  const r = await POST('/auth/signup', { name: 'Zz P', email: mkEmail('p6'), password: PW, phone: '6876543210' }); check(r.status === 400, `HTTP ${r.status}`); return `HTTP 400 "${err(r)}"`;
});
T('ET-17', 'Edge', 'Phone with 9 digits / 11 digits', 'Rejected', async () => {
  const a = await POST('/auth/signup', { name: 'Zz P', email: mkEmail('p9'), password: PW, phone: '987654321' });
  const b = await POST('/auth/signup', { name: 'Zz P', email: mkEmail('p11'), password: PW, phone: '98765432101' }); check(a.status === 400 && b.status === 400, `${a.status}/${b.status}`);
  return `9 digits -> 400, 11 digits -> 400 ("${err(a)}")`;
});
T('ET-18', 'Edge', 'Phone with letters / symbols / spaces', 'Rejected', async () => {
  const bad = ['98765abcde', '+919876543210', '98765 4321', '9876-54321'];
  for (const phone of bad) { const r = await POST('/auth/signup', { name: 'Zz P', email: mkEmail('pl'), password: PW, phone }); check(r.status === 400, `${phone} -> ${r.status}`); }
  return `${bad.join(', ')} -> all HTTP 400`;
});
T('ET-19', 'Edge', 'Phone boundaries: 7000000000 / 8999999999 / 9999999999', 'Accepted', async () => {
  for (const phone of ['7000000000', '8999999999', '9999999999']) { const r = await POST('/auth/signup', { name: 'Zz Edge', email: mkEmail('pb'), password: PW, phone }); check(r.status === 200, `${phone} -> ${r.status} ${err(r)}`); }
  return 'All three boundary numbers accepted (HTTP 200)';
});
T('ET-20', 'Edge', 'Password length: 7 / 8 / 64 / 65 characters', 'Rejected below 8 and above 64, accepted 8-64', async () => {
  const pw8 = 'Ab1@xYq9', pw64 = ('Zq7#mK2$').repeat(8), pw65 = pw64 + 'a', pw7 = 'Ab1@xY9';
  const t = async pw => (await POST('/auth/signup', { name: 'Zz Len', email: mkEmail('pl'), password: pw, phone: mkPhone() })).status;
  const res = [await t(pw7), await t(pw8), await t(pw64), await t(pw65)]; check(JSON.stringify(res) === '[400,200,200,400]', JSON.stringify(res));
  return `7 chars -> 400, 8 chars -> 200, 64 chars -> 200, 65 chars -> 400`;
});
T('ET-21', 'Edge', 'Release the same payout twice', 'Rejected', async () => {
  const c = await newCustomer('ps'); const o = await placeOrder(c.token); await POST(`/orders/${o.id}/pay`, {}, { token: c.token });
  await q(`UPDATE SubOrders SET sub_status='delivered' WHERE sub_order_id=$1`, [o.subA]); const s = await stl(o.subA);
  const a = await POST(`/platform/settlements/${s.settlement_id}/release`, {}, { token: S.admin }), b = await POST(`/platform/settlements/${s.settlement_id}/release`, {}, { token: S.admin });
  const n = await POST('/platform/settlements/99999999/release', {}, { token: S.admin });
  check(a.status === 200 && b.status === 409 && n.status === 404, `${a.status}/${b.status}/${n.status}`); return `First release 200; second 409 "${err(b)}"; unknown settlement 404`;
});

// =====================================================================================================
// FUNCTIONAL (FT)
// =====================================================================================================
// -- phone
T('FT-01', 'Functional', 'Signup with valid phone starting 7, 8, 9', 'Account created and login works', async () => {
  const out = [];
  for (const phone of ['7123456789', '8123456789', '9123456789']) { const email = mkEmail('ph'); const r = await POST('/auth/signup', { name: 'Zz Phone', email, password: PW, phone }); check(r.status === 200, `${phone}: ${r.status} ${err(r)}`); await login(email); out.push(phone); }
  return `${out.join(', ')} accepted and the users could log in`;
});
T('FT-02', 'Functional', 'Invalid phone: no account and NO login', 'Error message shown, user cannot log in', async () => {
  const email = mkEmail('nolog'), r = await POST('/auth/signup', { name: 'Zz No', email, password: PW, phone: '5123456789' });
  const l = await POST('/auth/login', { email, password: PW }); const n = (await q('SELECT COUNT(*)::int c FROM Users WHERE email=$1', [email])).rows[0].c;
  check(r.status === 400 && l.status === 401 && !l.json.token && n === 0, `${r.status}/${l.status}/${n}`);
  return `Signup HTTP 400 "${err(r)}"; login afterwards HTTP 401, no token; 0 rows in Users`;
});
T('FT-03', 'Functional', 'Missing phone', 'Rejected', async () => {
  const r = await POST('/auth/signup', { name: 'Zz Nophone', email: mkEmail('np'), password: PW }); check(r.status === 400, `HTTP ${r.status}`); return `HTTP 400 "${err(r)}"`;
});
T('FT-04', 'Functional', 'Database also refuses an invalid phone (even if API is bypassed)', 'Rejected by CHECK constraint', async () => {
  const e = await dbErr(`INSERT INTO Users(name,email,password_hash,phone) VALUES ('Zz',$1,'x','1234567890')`, [mkEmail('db')]);
  const f = await dbErr(`INSERT INTO Users(name,email,password_hash,phone) VALUES ('Zz',$1,'x',NULL)`, [mkEmail('db2')]);
  check(e.code === '23514' && f.code === '23514', `${e.code}/${f.code}`); return `Phone 1234567890 -> ${e.constraint}; NULL phone for a customer -> ${f.constraint}`;
});
// -- password
const weak = [['password', 'common word'], ['Password', 'no number / special'], ['password1!', 'no uppercase'], ['PASSWORD1!', 'no lowercase'], ['Password!!', 'no number'], ['Password12', 'no special character'], ['Ab1@xY', 'only 6 characters'], ['Abcd@1234', 'easy sequence'], ['Aaaa@xxxx1', 'repeated characters']];
T('FT-05', 'Functional', 'Weak passwords are rejected (9 different weak passwords)', 'Error message and NO login', async () => {
  for (const [pw, why] of weak) {
    const email = mkEmail('wk'), r = await POST('/auth/signup', { name: 'Zz Weak', email, password: pw, phone: mkPhone() });
    check(r.status === 400 && /weak/i.test(err(r)), `${pw} (${why}) -> ${r.status}`);
    const l = await POST('/auth/login', { email, password: pw }); check(l.status === 401, `login worked for ${pw}`);
  }
  return `${weak.length} weak passwords -> HTTP 400 "Password is too weak..."; none could log in`;
});
T('FT-06', 'Functional', 'Password containing the email name or the person\'s name', 'Rejected', async () => {
  const a = await POST('/auth/signup', { name: 'Zz Name', email: 'rahulsharma@x.com', password: 'Rahulsharma@9x', phone: mkPhone() });
  const b = await POST('/auth/signup', { name: 'Priyanka Kulkarni', email: mkEmail('nm'), password: 'Priyanka@2026x', phone: mkPhone() });
  check(a.status === 400 && b.status === 400, `${a.status}/${b.status}`); return `"${err(a)}"`;
});
T('FT-07', 'Functional', 'Strong password accepted and login works', 'Account created, login successful', async () => {
  const email = mkEmail('st'), r = await POST('/auth/signup', { name: 'Zz Strong', email, password: 'Tr!ckyP4ss#Word', phone: mkPhone() });
  check(r.status === 200, `HTTP ${r.status} ${err(r)}`); const l = await login(email, 'Tr!ckyP4ss#Word'); return `Signup 200; login OK as ${l.user.email}`;
});
T('FT-08', 'Functional', 'Frontend (browser) applies the same rules before sending', 'Same rules in login.html', async () => {
  const cjs = fs.readFileSync(path.join(ROOT, 'frontend/js/common.js'), 'utf8'), lh = fs.readFileSync(path.join(ROOT, 'frontend/login.html'), 'utf8');
  check(/phoneProblem\(body\.phone\)/.test(lh) && /passwordProblem\(body\.password/.test(lh) && /maxlength="10"/.test(lh) && /id="rules"/.test(lh), 'login.html misses checks');
  const vm = require('vm'), sb = {}; vm.createContext(sb); vm.runInContext(cjs.slice(cjs.indexOf('const PHONE_RE'), cjs.indexOf('// ---------- horizontal bar chart')) + ';this.phoneProblem=phoneProblem;this.passwordProblem=passwordProblem;', sb);
  const same = ['9876543210', '6876543210', '98765', 'abcdefghij'].every(p => (sb.phoneProblem(p) === null) === (phoneProblem(p) === null))
    && weak.every(([pw]) => !!sb.passwordProblem(pw) === !!passwordProblem(pw)) && !sb.passwordProblem('Tr!ckyP4ss#Word');
  check(same, 'browser and server rules differ'); return 'login.html shows live password checklist, limits phone to 10 digits; browser and server rules give identical results';
});
// -- one restaurant login
T('FT-09', 'Functional', 'ONE shared restaurant login', 'Login works; role restaurant_owner, portal=true', async () => {
  const l = await login(S.portalEmail); check(l.user.role === 'restaurant_owner' && l.user.portal === true, JSON.stringify(l.user)); return `Logged in as ${l.user.email}, role ${l.user.role}, portal=${l.user.portal}`;
});
T('FT-10', 'Functional', 'Before selecting a restaurant the panel shows nothing', 'Asked to select a restaurant (409)', async () => {
  await q('UPDATE Users SET restaurant_id=NULL WHERE email=$1', [S.portalEmail]);
  const a = await GET('/admin/orders', { token: S.portal }), b = await GET('/admin/restaurants', { token: S.portal }), c = await GET('/admin/settlements', { token: S.portal });
  check(a.status === 409 && b.status === 409 && c.status === 409, `${a.status}/${b.status}/${c.status}`); return `orders/restaurants/settlements -> 409 "${err(a)}"`;
});
T('FT-11', 'Functional', 'Restaurant list for the selector', 'All restaurants listed', async () => {
  const r = await GET('/portal/restaurants', { token: S.portal }), n = (await q('SELECT COUNT(*)::int c FROM Restaurants')).rows[0].c;
  check(r.status === 200 && r.json.restaurants.length === n, `${r.status}`); return `${r.json.restaurants.length} restaurants = ${n} in PostgreSQL`;
});
T('FT-12', 'Functional', 'Select restaurant A: only A\'s panel', 'Only restaurant A data visible', async () => {
  await setting(S.portal, S.A);
  const r = await GET('/admin/restaurants', { token: S.portal }); check(r.json.length === 1 && r.json[0].restaurant_id === S.A, 'wrong restaurant');
  const o = await GET('/admin/orders', { token: S.portal }); check(o.json.every(x => x.restaurant === S.nameA), 'foreign orders visible');
  const m = await GET(`/admin/restaurants/${S.B}/menu`, { token: S.portal }); const own = await GET(`/admin/restaurants/${S.A}/menu`, { token: S.portal });
  return `Restaurants -> only "${S.nameA}"; ${o.json.length} orders, all of A; (B menu request returns ${m.json.length ? 'items!' : 'nothing'}) own menu ${own.json.length} items`;
});
T('FT-13', 'Functional', 'Switch to restaurant B with the same login', 'Now only B data; A data hidden', async () => {
  await setting(S.portal, S.B);
  const r = await GET('/admin/restaurants', { token: S.portal }); check(r.json[0].restaurant_id === S.B, 'still A');
  const o = await GET('/admin/orders', { token: S.portal }); check(o.json.every(x => x.restaurant === S.nameB), 'A orders visible');
  const add = await POST('/admin/menu-items', { name: 'zz_B_' + rnd(), price: 10 }, { token: S.portal });
  const rid = (await q('SELECT restaurant_id FROM MenuItems WHERE item_id=$1', [add.json.item_id])).rows[0].restaurant_id; check(rid === S.B, 'item went to wrong restaurant');
  return `Same token now shows only "${S.nameB}"; a new menu item was saved under restaurant ${rid}`;
});
T('FT-14', 'Functional', 'Only the shared account may choose a restaurant', 'Others get 403', async () => {
  const a = await POST('/portal/select', { restaurant_id: S.B }, { token: S.ownerA }), b = await POST('/portal/select', { restaurant_id: S.B }, { token: S.cust.token }), c = await POST('/portal/select', { restaurant_id: S.B }, { token: S.admin }), d = await POST('/portal/select', { restaurant_id: S.B });
  check(a.status === 403 && b.status === 403 && c.status === 403 && d.status === 401, `${a.status}/${b.status}/${c.status}/${d.status}`);
  const still = (await q('SELECT restaurant_id FROM Users WHERE email=$1', [S.ownerAEmail])).rows[0].restaurant_id; check(still === S.A, 'owner A was moved');
  return `single-restaurant owner 403, customer 403, admin 403, no token 401; owner A still bound to restaurant ${still}`;
});
T('FT-15', 'Functional', 'Select a non-existing / invalid restaurant', 'Rejected', async () => {
  const a = await POST('/portal/select', { restaurant_id: 99999999 }, { token: S.portal }), b = await POST('/portal/select', { restaurant_id: 'abc' }, { token: S.portal });
  check(a.status === 404 && b.status === 400, `${a.status}/${b.status}`); return `99999999 -> 404 "${err(a)}"; "abc" -> 400`;
});
// -- payment safety
T('FT-16', 'Functional', 'Customer pays ONCE: the money is held by MultiEats, not by a restaurant', 'One payment; one settlement per restaurant, status held', async () => {
  const c = await newCustomer('pay1'); const o = await placeOrder(c.token); S.O1 = o; S.c1 = c;
  const p = await POST(`/orders/${o.id}/pay`, {}, { token: c.token }); check(p.status === 200 && /MultiEats/.test(p.json.message), `HTTP ${p.status} ${err(p)}`);
  const pays = (await q('SELECT COUNT(*)::int c FROM Payments WHERE order_id=$1', [o.id])).rows[0].c;
  const st = (await q('SELECT restaurant_id,status,gross_amount FROM Settlements WHERE order_id=$1 ORDER BY restaurant_id', [o.id])).rows;
  check(pays === 1 && st.length === 2 && st.every(s => s.status === 'held'), JSON.stringify(st));
  return `1 payment row; settlements: ${st.map(s => `restaurant ${s.restaurant_id}: ${s.gross_amount} (${s.status})`).join(', ')}`;
});
T('FT-17', 'Functional', 'Money adds up: payment = restaurant shares + delivery fee; share = commission + payout', 'Totals match to the paisa', async () => {
  const d = (await q(`SELECT o.total_amount, o.delivery_fee, (SELECT SUM(gross_amount) FROM Settlements WHERE order_id=o.order_id) g,
      (SELECT SUM(commission_amount+net_amount) FROM Settlements WHERE order_id=o.order_id) cn FROM Orders o WHERE o.order_id=$1`, [S.O1.id])).rows[0];
  check(+d.total_amount === +d.g + +d.delivery_fee && +d.cn === +d.g, JSON.stringify(d)); return `Paid ${d.total_amount} = shares ${d.g} + delivery fee ${d.delivery_fee}; commission + payouts = ${d.cn}`;
});
T('FT-18', 'Functional', 'Each restaurant (including the first/main one) sees ONLY its own settlement', 'No restaurant sees another restaurant\'s money', async () => {
  const a = await GET('/admin/settlements', { token: S.ownerA }), b = await GET('/admin/settlements', { token: S.ownerB });
  const ids = r => r.json.rows.map(x => x.sub_order_id);
  check(ids(a).includes(S.O1.subA) && !ids(a).includes(S.O1.subB) && ids(b).includes(S.O1.subB) && !ids(b).includes(S.O1.subA), 'a restaurant sees another share');
  return `Main restaurant A sees sub-order ${S.O1.subA} only; restaurant B sees sub-order ${S.O1.subB} only`;
});
T('FT-19', 'Functional', 'A restaurant (even the main one) cannot take or mark the payment', 'Only the customer can pay', async () => {
  const c = await newCustomer('pay2'); const o = await placeOrder(c.token);
  const a = await POST(`/orders/${o.id}/pay`, {}, { token: S.ownerA }), b = await POST(`/orders/${o.id}/pay`, {}, { token: S.admin });
  const st = (await q('SELECT status FROM Payments WHERE order_id=$1', [o.id])).rows[0].status; check(a.status === 404 && b.status === 404 && st === 'unpaid', `${a.status}/${b.status}/${st}`);
  S.O2 = o; S.c2 = c; return `Main restaurant -> ${a.status} "${err(a)}", admin -> ${b.status}; payment still "${st}"`;
});
T('FT-20', 'Functional', 'No payout before delivery', 'Release rejected (409)', async () => {
  const s = await stl(S.O1.subA), r = await POST(`/platform/settlements/${s.settlement_id}/release`, {}, { token: S.admin });
  check(r.status === 409, `HTTP ${r.status}`); return `Status "${s.status}" -> release HTTP 409 "${err(r)}"`;
});
T('FT-21', 'Functional', 'Main restaurant delivers its part: only ITS share becomes payable', 'A payable, B still held', async () => {
  const r = await PATCH(`/sub-orders/${S.O1.subA}/status`, { status: 'delivered' }, { token: S.ownerA }); check(r.status === 200, `HTTP ${r.status} ${err(r)}`);
  const a = await stl(S.O1.subA), b = await stl(S.O1.subB); check(a.status === 'payable' && b.status === 'held' && a.payable_at, `${a.status}/${b.status}`);
  return `Restaurant A share: ${a.status}; restaurant B share: ${b.status} (not affected by A)`;
});
T('FT-22', 'Functional', 'Only the main admin can release a payout', 'Others get 403', async () => {
  const s = await stl(S.O1.subA);
  const a = await POST(`/platform/settlements/${s.settlement_id}/release`, {}, { token: S.ownerA }), b = await POST(`/platform/settlements/${s.settlement_id}/release`, {}, { token: S.cust.token }), c = await POST(`/platform/settlements/${s.settlement_id}/release`, {}, { token: S.portal });
  check(a.status === 403 && b.status === 403 && c.status === 403, `${a.status}/${b.status}/${c.status}`); return `restaurant owner 403, customer 403, shared restaurant login 403`;
});
T('FT-23', 'Functional', 'MultiEats releases the payout to the restaurant', 'Status paid with reference and time', async () => {
  const s = await stl(S.O1.subA), r = await POST(`/platform/settlements/${s.settlement_id}/release`, { ref: 'UTR123456' }, { token: S.admin });
  check(r.status === 200, `HTTP ${r.status} ${err(r)}`); const a = await stl(S.O1.subA); check(a.status === 'paid' && a.payout_ref === 'UTR123456' && a.paid_at, JSON.stringify(a));
  return `HTTP 200; status ${a.status}, ref ${a.payout_ref}, net ${a.net_amount}`;
});
T('FT-24', 'Functional', 'Restaurant confirms it received the money', 'Status confirmed', async () => {
  const s = await stl(S.O1.subA), r = await POST(`/admin/settlements/${s.settlement_id}/confirm`, { received: true }, { token: S.ownerA });
  check(r.status === 200, `HTTP ${r.status}`); const a = await stl(S.O1.subA); check(a.status === 'confirmed' && a.confirmed_at, a.status); return `Status ${a.status} at ${a.confirmed_at.toISOString()}`;
});
T('FT-25', 'Functional', 'A restaurant cannot confirm / touch another restaurant\'s payout', 'Rejected (404)', async () => {
  const b = await stl(S.O1.subB), r = await POST(`/admin/settlements/${b.settlement_id}/confirm`, { received: true }, { token: S.ownerA });
  check(r.status === 404, `HTTP ${r.status}`); return `Owner A on B's settlement -> 404 "${err(r)}"`;
});
T('FT-26', 'Functional', 'Dispute: restaurant says money not received', 'Needs a reason; status disputed; visible to admin', async () => {
  await PATCH(`/sub-orders/${S.O1.subB}/status`, { status: 'delivered' }, { token: S.ownerB }); const b = await stl(S.O1.subB);
  await POST(`/platform/settlements/${b.settlement_id}/release`, {}, { token: S.admin });
  const noNote = await POST(`/admin/settlements/${b.settlement_id}/confirm`, { received: false }, { token: S.ownerB });
  const ok = await POST(`/admin/settlements/${b.settlement_id}/confirm`, { received: false, note: 'Money not in my bank' }, { token: S.ownerB });
  const adm = await GET('/platform/settlements', { token: S.admin }); const row = adm.json.rows.find(x => x.settlement_id === b.settlement_id);
  check(noNote.status === 400 && ok.status === 200 && row.status === 'disputed' && /not in my bank/.test(row.dispute_note) && adm.json.summary.disputes >= 1, `${noNote.status}/${ok.status}/${row && row.status}`);
  return `No reason -> 400 "${err(noNote)}"; with reason -> 200; admin sees status "${row.status}", note "${row.dispute_note}", open disputes ${adm.json.summary.disputes}`;
});
T('FT-27', 'Functional', 'Restaurant cancels its part: refund only that share, other share unaffected', 'B refunded, A held, order continues', async () => {
  const o = S.O2; await POST(`/orders/${o.id}/pay`, {}, { token: S.c2.token });
  const r = await PATCH(`/sub-orders/${o.subB}/status`, { status: 'cancelled', reason: 'Out of stock' }, { token: S.ownerB }); check(r.status === 200, `HTTP ${r.status} ${err(r)}`);
  const b = await stl(o.subB), a = await stl(o.subA), f = (await q('SELECT amount FROM Refunds WHERE sub_order_id=$1', [o.subB])).rows[0], ov = (await q('SELECT overall_status FROM Orders WHERE order_id=$1', [o.id])).rows[0].overall_status;
  check(b.status === 'refunded' && a.status === 'held' && +f.amount === +b.gross_amount && ov !== 'cancelled', `${b.status}/${a.status}/${ov}`);
  return `B: ${b.status} (refund ${f.amount}); A: ${a.status}; order status "${ov}"`;
});
T('FT-28', 'Functional', 'Cannot cancel after the payout was released', 'Rejected (409), nothing changed', async () => {
  const o = S.O2; await PATCH(`/sub-orders/${o.subA}/status`, { status: 'delivered' }, { token: S.ownerA }); const s = await stl(o.subA);
  await POST(`/platform/settlements/${s.settlement_id}/release`, {}, { token: S.admin });
  const r = await PATCH(`/sub-orders/${o.subA}/status`, { status: 'cancelled', reason: 'late' }, { token: S.ownerA });
  const sub = (await q('SELECT sub_status FROM SubOrders WHERE sub_order_id=$1', [o.subA])).rows[0].sub_status, rf = (await q('SELECT COUNT(*)::int c FROM Refunds WHERE sub_order_id=$1', [o.subA])).rows[0].c;
  check(r.status === 409 && sub === 'delivered' && rf === 0, `${r.status}/${sub}/${rf}`); return `HTTP 409 "${err(r)}"; sub-order still "${sub}", ${rf} refunds`;
});
T('FT-29', 'Functional', 'Settlement creation is idempotent (no double entries)', 'Second call creates 0 rows', async () => {
  const n = (await q('SELECT sp_create_settlements($1) n', [S.O1.id])).rows[0].n, c = (await q('SELECT COUNT(*)::int c FROM Settlements WHERE order_id=$1', [S.O1.id])).rows[0].c;
  check(n === 0 && c === 2, `${n}/${c}`); return `Called again -> ${n} new rows; still ${c} settlements`;
});
T('FT-30', 'Functional', 'Admin settlement summary equals the database', 'Totals match', async () => {
  const r = await GET('/platform/settlements', { token: S.admin }), s = r.json.summary;
  const db = (await q(`SELECT COALESCE(SUM(net_amount) FILTER (WHERE status<>'refunded'),0) n FROM Settlements`)).rows[0].n;
  const api = +s.held + +s.payable + +s.paid + +s.confirmed + +s.disputed; check(Math.abs(api - db) < 0.01, `${api} vs ${db}`);
  return `held+payable+paid+confirmed+disputed = ${api.toFixed(2)} = PostgreSQL ${db}; commission ${s.commission}`;
});
T('FT-31', 'Functional', 'Existing paid orders were back-filled into the ledger', 'Every paid order has settlements', async () => {
  const n = (await q(`SELECT COUNT(*)::int c FROM Payments p WHERE p.status='paid' AND NOT EXISTS (SELECT 1 FROM Settlements s WHERE s.order_id=p.order_id) AND EXISTS (SELECT 1 FROM SubOrders so WHERE so.order_id=p.order_id AND so.sub_status<>'cancelled')`)).rows[0].c;
  check(n === 0, `${n} paid orders without settlements`); return '0 paid orders are missing a settlement row';
});
// -- charts
T('FT-32', 'Functional', 'Admin dashboard "Orders per customer" chart data', 'Top 10 customers, highest first', async () => {
  const r = await GET('/platform/orders-per-customer', { token: S.admin }); const v = r.json.map(x => x.orders);
  check(r.status === 200 && r.json.length <= 10 && v.every((x, i) => i === 0 || v[i - 1] >= x), JSON.stringify(v));
  const db = (await q('SELECT COUNT(*)::int c FROM Orders o JOIN Users u ON u.user_id=o.user_id WHERE u.name=$1', [r.json[0].name])).rows[0].c; check(db >= r.json[0].orders, 'count mismatch');
  return `${r.json.length} bars, sorted descending, e.g. "${r.json[0].name}" = ${r.json[0].orders}`;
});
T('FT-33', 'Functional', 'Restaurant dashboard chart is limited to that restaurant', 'Counts only this restaurant\'s orders', async () => {
  await setting(S.portal, S.A); const r = await GET('/admin/orders-per-customer', { token: S.portal });
  const db = (await q(`SELECT u.name, COUNT(DISTINCT so.order_id)::int c FROM SubOrders so JOIN Orders o ON o.order_id=so.order_id JOIN Users u ON u.user_id=o.user_id WHERE so.restaurant_id=$1 GROUP BY u.user_id,u.name ORDER BY 2 DESC,1 LIMIT 10`, [S.A])).rows;
  check(r.status === 200 && JSON.stringify(r.json.map(x => [x.name, x.orders])) === JSON.stringify(db.map(x => [x.name, x.c])), 'differs from PostgreSQL');
  const cu = await GET('/admin/orders-per-customer', { token: S.cust.token }); check(cu.status === 403, 'customer allowed');
  return `${r.json.length} bars for "${S.nameA}" equal the PostgreSQL GROUP BY result; customer token -> 403`;
});
T('FT-34', 'Functional', 'Both dashboards render the bar chart', 'barChart() used on admin and restaurant dashboards', async () => {
  const f = n => fs.readFileSync(path.join(ROOT, 'frontend', n), 'utf8');
  check(/barChart\('Orders per customer',opc\)/.test(f('admin.html')) && /barChart\('Orders per customer',opc\)/.test(f('owner.html')) && /bar-track/.test(f('css/style.css')), 'chart missing');
  return 'admin.html and owner.html call barChart(); gradient bar CSS present in style.css';
});

// =====================================================================================================
// NON-FUNCTIONAL (NFT)
// =====================================================================================================
const timeIt = async (n, fn) => { const t = []; for (let i = 0; i < n; i++) { const s = performance.now(); await fn(); t.push(performance.now() - s); } t.sort((a, b) => a - b); return { med: t[Math.floor(n / 2)], max: t[n - 1] }; };
T('NFT-01', 'Non-functional', 'Performance: restaurant list response time', 'Median < 300 ms', async () => {
  const t = await timeIt(15, () => GET('/restaurants')); check(t.med < 300, `${t.med.toFixed(0)} ms`); return `median ${t.med.toFixed(0)} ms, max ${t.max.toFixed(0)} ms (15 requests)`;
});
T('NFT-02', 'Non-functional', 'Performance: admin dashboard queries (JOIN/aggregate)', 'Median < 400 ms', async () => {
  const t = await timeIt(10, async () => { await GET('/platform/dashboard', { token: S.admin }); await GET('/platform/orders-per-customer', { token: S.admin }); await GET('/platform/settlements', { token: S.admin }); });
  check(t.med < 400, `${t.med.toFixed(0)} ms`); return `3 dashboard calls: median ${t.med.toFixed(0)} ms, max ${t.max.toFixed(0)} ms`;
});
T('NFT-03', 'Non-functional', 'Performance: place an order', 'Median < 800 ms', async () => {
  const c = await newCustomer('perf'), t = await timeIt(5, () => placeOrder(c.token)); check(t.med < 800, `${t.med.toFixed(0)} ms`); return `median ${t.med.toFixed(0)} ms, max ${t.max.toFixed(0)} ms (5 orders)`;
});
T('NFT-04', 'Non-functional', 'Load: 60 concurrent requests', 'All succeed; 95th percentile < 2 s', async () => {
  const t = []; const rs = await Promise.all(Array.from({ length: 60 }, async () => { const s = performance.now(); const r = await GET('/restaurants'); t.push(performance.now() - s); return r.status; }));
  t.sort((a, b) => a - b); const p95 = t[Math.floor(t.length * 0.95) - 1]; check(rs.every(x => x === 200) && p95 < 2000, `p95 ${p95.toFixed(0)}`);
  return `60/60 returned 200; p95 ${p95.toFixed(0)} ms, max ${t[59].toFixed(0)} ms`;
});
T('NFT-05', 'Non-functional', 'Scalability: 150 sequential requests, no errors / leaks', 'All 200', async () => {
  let bad = 0; for (let i = 0; i < 150; i++) { const r = await GET(i % 3 ? '/restaurants' : '/health'); if (r.status !== 200) bad++; } check(bad === 0, `${bad} failed`); return '150/150 requests answered with HTTP 200';
});
T('NFT-06', 'Non-functional', 'Security: passwords stored hashed, never returned', 'bcrypt hash in DB; no password_hash in any response', async () => {
  const h = (await q('SELECT password_hash FROM Users WHERE email=$1', [S.adminEmail])).rows[0].password_hash; check(/^\$2[aby]\$/.test(h) && h !== PW, 'not bcrypt');
  const l = await POST('/auth/login', { email: S.adminEmail, password: PW }), g = await GET('/platform/customer-activity', { token: S.admin }), o = await GET('/orders/' + S.O1.id, { token: S.c1.token });
  check(![l.text, g.text, o.text].some(t => /password/i.test(t)), 'password text leaked'); return `Stored as ${h.slice(0, 7)}… (bcrypt); login, activity and order responses contain no password field`;
});
T('NFT-07', 'Non-functional', 'Security: forged / tampered / expired tokens', 'All rejected with 401', async () => {
  const ok = S.admin, bad1 = ok.slice(0, -2) + (ok.endsWith('AA') ? 'BB' : 'AA'), uid = (await q('SELECT user_id FROM Users WHERE email=$1', [S.adminEmail])).rows[0].user_id;
  const expired = signToken(uid, Date.now() - 1000), forged = signToken(uid, Date.now() + 1e6).replace(/.$/, c => c === 'a' ? 'b' : 'a'), none = 'abc.def';
  const rs = []; for (const t of [bad1, expired, forged, none, '']) rs.push((await GET('/platform/dashboard', { token: t || undefined })).status);
  check(rs.every(s => s === 401), rs.join()); const good = await GET('/platform/dashboard', { token: ok }); check(good.status === 200, 'valid token rejected');
  return `tampered/expired/forged/garbage/missing -> ${rs.join(', ')}; valid token -> 200`;
});
T('NFT-08', 'Non-functional', 'Security: role-based access (privilege escalation)', 'Wrong role gets 403', async () => {
  const cases = [['customer -> /admin/dashboard', S.cust.token, '/admin/dashboard'], ['customer -> /platform/dashboard', S.cust.token, '/platform/dashboard'], ['customer -> /platform/settlements', S.cust.token, '/platform/settlements'],
    ['owner -> /platform/dashboard', S.ownerA, '/platform/dashboard'], ['owner -> /platform/settlements', S.ownerA, '/platform/settlements'], ['shared restaurant login -> /platform/dashboard', S.portal, '/platform/dashboard'], ['admin -> /admin/orders (restaurant panel)', S.admin, '/admin/orders']];
  const out = []; for (const [n, t, p] of cases) { const r = await GET(p, { token: t }); check(r.status === 403, `${n} -> ${r.status}`); out.push(r.status); }
  const o = await GET('/orders/' + S.O1.id, { token: (await newCustomer('other')).token }); check(o.status === 404, `other customer saw the order (${o.status})`);
  return `${cases.length} forbidden combinations -> ${out.join(',')}; another customer cannot open order #${S.O1.id} (404)`;
});
T('NFT-09', 'Non-functional', 'Security: brute-force login protection', 'Locked after 8 failed attempts (429)', async () => {
  const email = mkEmail('bf'), codes = []; for (let i = 0; i < 10; i++) codes.push((await POST('/auth/login', { email, password: 'Wrong@Pass1' })).status);
  check(codes.slice(0, 8).every(c => c === 401) && codes[8] === 429, codes.join()); return `Attempts 1-8 -> 401, attempt 9+ -> 429 (${codes.join(',')})`;
});
T('NFT-10', 'Non-functional', 'Security: response headers', 'nosniff, X-Frame-Options, Referrer-Policy present', async () => {
  const r = await GET('/health'), h = ['x-content-type-options', 'x-frame-options', 'referrer-policy'].map(k => r.headers.get(k)); check(h.every(Boolean), h.join()); return `X-Content-Type-Options: ${h[0]}, X-Frame-Options: ${h[1]}, Referrer-Policy: ${h[2]}`;
});
T('NFT-11', 'Non-functional', 'Reliability: malformed JSON never crashes the server', 'JSON error, server alive', async () => {
  const r = await http('POST', '/auth/login', { raw: '{"email": "a@b.com", ' }); const h = await GET('/health');
  check(r.status === 400 && r.json && r.json.error && h.status === 200, `${r.status}/${h.status}`); return `HTTP 400 JSON "${err(r)}"; /health still 200`;
});
T('NFT-12', 'Non-functional', 'Reliability / concurrency: 20 parallel signups with the same email', 'Exactly one succeeds, others 409', async () => {
  const b = { name: 'Zz Race', email: mkEmail('race'), password: PW, phone: mkPhone() };
  const rs = (await Promise.all(Array.from({ length: 20 }, () => POST('/auth/signup', b)))).map(r => r.status); const ok = rs.filter(s => s === 200).length, dup = rs.filter(s => s === 409).length;
  check(ok === 1 && dup === 19, `${ok} ok / ${dup} dup`); return `1 x HTTP 200 and 19 x HTTP 409; PostgreSQL UNIQUE constraint held under race`;
});
T('NFT-13', 'Non-functional', 'Data integrity / concurrency: 10 parallel payments for one order', 'Exactly one payment succeeds; one settlement set', async () => {
  const c = await newCustomer('race2'), o = await placeOrder(c.token);
  const rs = (await Promise.all(Array.from({ length: 10 }, () => POST(`/orders/${o.id}/pay`, {}, { token: c.token })))).map(r => r.status);
  const n = (await q('SELECT COUNT(*)::int c FROM Settlements WHERE order_id=$1', [o.id])).rows[0].c; check(rs.filter(s => s === 200).length === 1 && n === 2, `${rs.join()} / ${n}`);
  return `${rs.filter(s => s === 200).length} x 200, ${rs.filter(s => s === 409).length} x 409 ("Already paid"); ${n} settlements (no duplicates)`;
});
T('NFT-14', 'Non-functional', 'Data integrity: every order total = items + delivery fee; no orphan rows', 'No inconsistent rows', async () => {
  const a = (await q(`SELECT COUNT(*)::int c FROM Orders o WHERE ABS(o.total_amount - (o.subtotal + o.delivery_fee)) > 0.01`)).rows[0].c;
  const b = (await q(`SELECT COUNT(*)::int c FROM SubOrders so WHERE NOT EXISTS (SELECT 1 FROM Orders o WHERE o.order_id=so.order_id)`)).rows[0].c;
  const c = (await q(`SELECT COUNT(*)::int c FROM Settlements s WHERE NOT EXISTS (SELECT 1 FROM SubOrders so WHERE so.sub_order_id=s.sub_order_id)`)).rows[0].c;
  const d = (await q(`SELECT COUNT(*)::int c FROM Orders o WHERE ABS(o.subtotal - (SELECT COALESCE(SUM(sub_amount),0) FROM SubOrders WHERE order_id=o.order_id)) > 0.01`)).rows[0].c;
  check(!a && !b && !c && !d, `${a}/${b}/${c}/${d}`); return `0 orders with wrong total, 0 orphan sub-orders, 0 orphan settlements, 0 orders whose subtotal differs from its sub-orders`;
});
T('NFT-15', 'Non-functional', 'Maintainability: upgrade script is idempotent', 'Running v2_upgrade.sql again causes no error and no data loss', async () => {
  const before = (await q('SELECT (SELECT COUNT(*) FROM Settlements) s, (SELECT COUNT(*) FROM Users) u')).rows[0];
  await q(fs.readFileSync(path.join(ROOT, 'database', 'v2_upgrade.sql'), 'utf8'));
  const after = (await q('SELECT (SELECT COUNT(*) FROM Settlements) s, (SELECT COUNT(*) FROM Users) u')).rows[0]; check(before.s === after.s && before.u === after.u, 'row counts changed');
  return `Re-ran database/v2_upgrade.sql: no error; settlements ${after.s}, users ${after.u} unchanged`;
});
T('NFT-16', 'Non-functional', 'Usability / compatibility: every page is responsive and titled', 'viewport meta, <title>, labelled login fields', async () => {
  const pages = fs.readdirSync(path.join(ROOT, 'frontend')).filter(f => f.endsWith('.html')); const bad = pages.filter(f => { const t = fs.readFileSync(path.join(ROOT, 'frontend', f), 'utf8'); return !/name="viewport"/.test(t) || !/<title>[^<]+<\/title>/.test(t); });
  const lh = fs.readFileSync(path.join(ROOT, 'frontend/login.html'), 'utf8'); check(!bad.length && /<label>Email<\/label>/.test(lh) && /<label>Password<\/label>/.test(lh) && /type="password"/.test(lh), bad.join());
  return `${pages.length} pages have viewport + title; login uses labels, masked password field and live password checklist`;
});
T('NFT-17', 'Non-functional', 'Recoverability: server restarts cleanly after a crash/stop', 'Healthy again', async () => {
  S.server = await startServer(PORT); const h = await GET('/health'); check(h.status === 200 && h.json.database === 'connected', `${h.status}`); return `Restarted: /health -> ${h.status}, database ${h.json.database}`;
}, { late: 3 });

// ---------- run + report ----------
(async () => {
  console.log('MultiEats test run  —  database:', `${pool.options.host}:${pool.options.port}/${pool.options.database}`);
  await pool.query('SELECT 1');
  S.server = await startServer(PORT); await setup();
  const order = [...tests.filter(t => !t.late), ...tests.filter(t => t.late).sort((a, b) => a.late - b.late)];
  for (const t of order) {
    const s = performance.now();
    try { t.actual = await t.run(); t.status = 'PASS'; } catch (e) { t.actual = (e && e.message) || String(e); t.status = 'FAIL'; }
    t.ms = Math.round(performance.now() - s);
    console.log(`${t.status === 'PASS' ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${t.id.padEnd(7)} ${t.scenario}  ${t.status === 'FAIL' ? '\n        -> ' + t.actual : ''}`);
  }
  try { S.server.kill(); } catch {}
  await cleanup(); await pool.end();
  const groups = ['Standard', 'Edge', 'Functional', 'Non-functional'], esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const pass = tests.filter(t => t.status === 'PASS').length, v = (await (async () => 'PostgreSQL')());
  let md = `# MultiEats — Test Report\n\nGenerated: ${new Date().toISOString()}  \nNode ${process.version} · ${process.platform} · database ${process.env.DB_NAME || 'food_delivery'}  \n**Result: ${pass} / ${tests.length} PASSED**\n\n` +
    `Note: the project uses PostgreSQL; wherever the college sheet says "MySQL" the same test is executed on PostgreSQL. "Actual Result" is what the program really returned during this run.\n`;
  const titles = { Standard: '20. Standard / Compulsory Test Cases', Edge: '21. Edge Test Cases', Functional: 'Functional Test Cases (new features)', 'Non-functional': 'Non-functional Test Cases (performance, security, reliability, integrity, usability)' };
  for (const g of groups) {
    md += `\n## ${titles[g]}\n\n| Test ID | Scenario | Expected Result | Actual Result | Status |\n|---|---|---|---|---|\n`;
    for (const t of tests.filter(x => x.group === g).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))) md += `| ${t.id} | ${esc(t.scenario)} | ${esc(t.expected)} | ${esc(t.actual)} | ${t.status} |\n`;
  }
  fs.writeFileSync(path.join(ROOT, 'TEST_REPORT.md'), md);
  console.log(`\n${pass} / ${tests.length} passed.  Report written to TEST_REPORT.md`);
  process.exit(pass === tests.length ? 0 : 1);
})().catch(async e => { console.error('Test run aborted:', e.message); try { S.server && S.server.kill(); await cleanup(); } catch {} process.exit(2); });
