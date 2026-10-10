// HTTP gateway for the database tier.
// ALL business logic (combo rules, fees, orders, payments, delivery, refunds, access control) lives in PostgreSQL stored
// procedures (database/procedures.sql). This file only: 1) hashes passwords, 2) issues / checks the login token,
// 3) turns each HTTP request into ONE call  SELECT sp_xxx(...)  and 4) maps database errors to HTTP status codes.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config();
const crypto = require('crypto');
const express = require('express'), cors = require('cors'), bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const { phoneProblem, passwordProblem } = require('./validators');
const poolConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
  : {
      user: process.env.DB_USER, password: process.env.DB_PASSWORD,
      host: process.env.DB_HOST || 'localhost', port: process.env.DB_PORT || 5432,
      database: process.env.DB_NAME || 'food_delivery',
    };
const pool = new Pool({
  ...poolConfig,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
});
pool.on('error', (err) => {
  console.error('Unexpected error on idle database client', err);
});
const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '100kb' }));          // very large bodies are refused with HTTP 413
app.use((_req, res, next) => {                       // basic security headers
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
  next();
});
app.use(express.static(path.join(__dirname, '..', 'frontend')));
// ---------- login token (HMAC signed, no extra packages). The role is NOT in the token: the database checks it. ----------
const SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.AUTH_SECRET) console.warn('AUTH_SECRET is not set in .env: using a random one, everyone is logged out when the server restarts.');
const TOKEN_HOURS = 12;
const mac = b64 => crypto.createHmac('sha256', SECRET).update(b64).digest('base64url');
const sign = uid => { const b = Buffer.from(JSON.stringify({ uid, exp: Date.now() + TOKEN_HOURS * 3600e3 })).toString('base64url'); return `${b}.${mac(b)}`; };
function verify(token) {
  const [b, s] = String(token || '').split('.');
  if (!b || !s) return null;
  const good = Buffer.from(mac(b)), given = Buffer.from(s);
  if (good.length !== given.length || !crypto.timingSafeEqual(good, given)) return null;
  try { const p = JSON.parse(Buffer.from(b, 'base64url').toString()); return p.exp > Date.now() ? p.uid : null; } catch { return null; }
}
app.use((req, _res, next) => { req.actor = verify((req.headers.authorization || '').replace(/^Bearer /, '')); next(); });
const needAuth = (req, res, next) => req.actor ? next() : res.status(401).json({ error: 'Please log in' });

// ---------- gateway helpers ----------
// database errors raised by sp_fail() carry SQLSTATE 'MX' + HTTP status, e.g. MX404
const fail = (res, e) => {
  if (/^MX\d{3}$/.test(e.code)) return res.status(+e.code.slice(2)).json({ error: e.message });
  if (e.code && (e.code.startsWith('22') || e.code === '23514')) return res.status(400).json({ error: 'Invalid input' });
  console.error(e); res.status(500).json({ error: 'Something went wrong' });
};
const call = async (fn, args = []) =>
  (await pool.query(`SELECT ${fn}(${args.map((_, i) => '$' + (i + 1)).join(',')}) AS r`, args)).rows[0].r;
// route('get', '/path', 'sp_name', req => [args], needsLogin)
const route = (method, path, fn, args = () => [], auth = false) =>
  app[method](path, ...(auth ? [needAuth] : []), async (req, res) => {
    try { res.json(await call(fn, args(req))); } catch (e) { fail(res, e); }
  });
const json = o => JSON.stringify(o ?? {});
const opt = v => (v === '' ? null : v);   // empty query value = not given

// ---------- Auth ----------
app.post('/auth/signup', async (req, res) => {
  try {
    const { name, email, password, phone } = req.body || {};
    if (!String(name || '').trim() || !String(email || '').trim() || !password) return res.status(400).json({ error: 'Name, email and password are required' });
    const bad = phoneProblem(phone) || passwordProblem(password, { email, name });   // invalid phone / weak password: no account, no login
    if (bad) return res.status(400).json({ error: bad });
    res.json(await call('sp_signup', [name, email, await bcrypt.hash(String(password), 10), String(phone).trim()]));
  } catch (e) { fail(res, e); }
});
// brute-force protection: 8 wrong passwords for the same email+IP in 10 minutes -> HTTP 429
const FAILS = new Map(), MAX_FAILS = 8, WINDOW_MS = 10 * 60e3;
const failKey = req => `${req.ip}|${String((req.body || {}).email || '').toLowerCase().trim()}`;
app.post('/auth/login', async (req, res) => {
  try {
    const key = failKey(req), rec = FAILS.get(key);
    if (rec && rec.until > Date.now() && rec.n >= MAX_FAILS)
      return res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil((rec.until - Date.now()) / 60e3)} minute(s).` });
    const u = await call('sp_get_login', [String((req.body || {}).email || '')]);
    if (!u || !(await bcrypt.compare(String((req.body || {}).password || ''), u.password_hash))) {
      const r = rec && rec.until > Date.now() ? rec : { n: 0, until: Date.now() + WINDOW_MS };
      r.n++; FAILS.set(key, r);
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    FAILS.delete(key);
    res.json({ user: { user_id: u.user_id, name: u.name, email: u.email, role: u.role, portal: !!u.portal }, token: sign(u.user_id) });
  } catch (e) { fail(res, e); }
});

// ---------- Restaurants (public) ----------
route('get', '/restaurants', 'sp_list_restaurants');
route('get', '/restaurants/nearby', 'sp_nearby', q => [opt(q.query.lat), opt(q.query.lng), opt(q.query.radius)]);
route('get', '/restaurants/suggestions', 'sp_suggestions',
  q => [opt(q.query.lat), opt(q.query.lng), opt(q.query.radius), (q.query.exclude || '').split(',').map(Number).filter(Number.isInteger)]);
route('get', '/restaurants/:id', 'sp_restaurant_detail', q => [q.params.id, opt(q.query.lat), opt(q.query.lng)]);
route('post', '/cart/validate', 'sp_validate_combo',
  q => [Array.isArray(q.body.restaurant_ids) ? q.body.restaurant_ids.map(Number) : null, q.body.lat, q.body.lng]);

// ---------- Orders (logged-in customer; the customer is taken from the token, never from the request body) ----------
route('post', '/orders', 'sp_place_order', q => [q.actor, q.body.delivery_address, q.body.delivery_lat, q.body.delivery_lng,
  json(Array.isArray(q.body.items) ? q.body.items.map(i => ({ item_id: Number(i.item_id), quantity: i.quantity })) : null)], true);
route('get', '/orders/:id', 'sp_order_detail', q => [q.actor, q.params.id], true);
route('post', '/orders/:id/pay', 'sp_pay_order', q => [q.actor, q.params.id], true);
route('post', '/orders/:id/assign-delivery', 'sp_assign_delivery', q => [q.actor, q.params.id], true);
app.get('/users/:id/orders', needAuth, async (req, res) => {
  if (String(req.actor) !== req.params.id) return res.status(403).json({ error: 'You can only see your own orders' });
  try { res.json(await call('sp_user_orders', [req.actor])); } catch (e) { fail(res, e); }
});

// ---------- Restaurant panel (the database refuses everyone whose role is not 'restaurant') ----------
route('patch', '/sub-orders/:id/status', 'sp_update_sub_order_status', q => [q.actor, q.params.id, q.body.status, q.body.reason], true);
route('get', '/admin/dashboard', 'sp_admin_dashboard', q => [q.actor], true);
route('get', '/admin/reports/revenue', 'sp_admin_revenue_report', q => [q.actor], true);
route('get', '/admin/orders', 'sp_admin_orders', q => [q.actor], true);

route('get', '/admin/sub-orders', 'sp_admin_sub_orders', q => [q.actor], true);
route('get', '/admin/refunds', 'sp_admin_refunds', q => [q.actor], true);
route('get', '/admin/restaurants', 'sp_admin_restaurants', q => [q.actor], true);
route('patch', '/admin/restaurants/:id', 'sp_admin_update_restaurant', q => [q.actor, q.params.id, json(q.body)], true);
route('get', '/admin/restaurants/:id/menu', 'sp_admin_restaurant_menu', q => [q.actor, q.params.id], true);
route('post', '/admin/menu-items', 'sp_admin_add_menu_item', q => [q.actor, json(q.body)], true);
route('patch', '/admin/menu-items/:id', 'sp_admin_update_menu_item', q => [q.actor, q.params.id, json(q.body)], true);
route('delete', '/admin/menu-items/:id', 'sp_admin_delete_menu_item', q => [q.actor, q.params.id], true);
route('get', '/admin/customer-history', 'sp_admin_customer_history', q => [q.actor], true);
route('post', '/admin/switch-restaurant', 'sp_admin_switch_restaurant', q => [q.actor, q.body.restaurant_id], true);
route('get', '/platform/dashboard', 'sp_platform_dashboard', q => [q.actor], true);
route('get', '/platform/customer-activity', 'sp_platform_customer_activity', q => [q.actor], true);
route('get', '/platform/restaurant-activity', 'sp_platform_restaurant_activity', q => [q.actor], true);
// ---------- One shared restaurant login: pick a restaurant, then only that restaurant's panel is served ----------
route('get', '/portal/restaurants', 'sp_portal_restaurants', q => [q.actor], true);
route('post', '/portal/select', 'sp_portal_select_restaurant', q => [q.actor, q.body.restaurant_id], true);
route('post', '/portal/restaurants', 'sp_owner_add_restaurant', q => [q.actor, json(q.body)], true);   // add a new restaurant (shared panel account only)
// ---------- Payment safety: MultiEats holds the money, restaurants are paid from the settlement ledger ----------
route('get', '/admin/settlements', 'sp_owner_settlements', q => [q.actor], true);
route('post', '/admin/settlements/:id/confirm', 'sp_owner_confirm_payout', q => [q.actor, q.params.id, q.body.received !== false, q.body.note], true);
route('get', '/platform/settlements', 'sp_platform_settlements', q => [q.actor], true);
route('post', '/platform/settlements/release-all', 'sp_platform_release_all', q => [q.actor], true);
route('post', '/platform/settlements/:id/release', 'sp_platform_release_payout', q => [q.actor, q.params.id, q.body.ref], true);
// ---------- Chart data ----------
route('get', '/admin/orders-per-customer', 'sp_owner_orders_per_customer', q => [q.actor], true);
route('get', '/platform/orders-per-customer', 'sp_platform_orders_per_customer', q => [q.actor], true);
// ---------- Health: shows that both tiers are alive (used by the Architecture page) ----------
app.get('/health', async (_q, res) => {
  const t0 = Date.now();
  try {
    const h = await call('sp_health');
    res.json({ server: 'up', port: +(process.env.PORT || 5000), database: 'connected', ...h, db_ms: Date.now() - t0 });
  } catch (e) { res.status(503).json({ server: 'up', database: 'down', error: e.message }); }
});

const PORT = process.env.PORT || 5000;
// bad JSON / too-large body / anything else that escapes a route: always answer with JSON, never crash
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON in request' });
  console.error(err); res.status(500).json({ error: 'Something went wrong' });
});

app.listen(PORT, '0.0.0.0', () => console.log(`Gateway running on http://localhost:${PORT}`));
