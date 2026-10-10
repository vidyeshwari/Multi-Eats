const API = window.API_BASE || 'http://localhost:5000';
const $ = (s, r = document) => r.querySelector(s);
const money = n => '₹' + Number(n || 0).toFixed(2);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set: (k, v) => localStorage.setItem(k, JSON.stringify(v)), del: k => localStorage.removeItem(k) };
const getUser = () => store.get('user', null);
const isAdmin = () => { const u = getUser(); return !!u && u.role === 'admin'; };
const isStaff = () => { const u = getUser(); return !!u && u.role === 'restaurant_owner'; };  // UI only: the database enforces the real check
const getCart = () => store.get('cart', []);
const setCart = c => { store.set('cart', c); const b = $('#cbadge'); if (b) b.textContent = c.reduce((s, i) => s + i.quantity, 0); };

// Real Pune localities (approximate centres) - the customer picks where the food should be delivered
const PUNE_AREAS = [
  { label: 'Deccan Gymkhana', lat: 18.5167, lng: 73.8419 }, { label: 'Shivajinagar', lat: 18.5308, lng: 73.8474 },
  { label: 'Sadashiv Peth', lat: 18.5117, lng: 73.8510 }, { label: 'Kothrud', lat: 18.5074, lng: 73.8077 },
  { label: 'Karve Road', lat: 18.5017, lng: 73.8236 }, { label: 'Camp', lat: 18.5155, lng: 73.8790 },
  { label: 'Swargate', lat: 18.5018, lng: 73.8636 }, { label: 'Koregaon Park', lat: 18.5362, lng: 73.8938 },
  { label: 'Kalyani Nagar', lat: 18.5457, lng: 73.9022 }, { label: 'Viman Nagar', lat: 18.5679, lng: 73.9143 },
  { label: 'Magarpatta / Hadapsar', lat: 18.5146, lng: 73.9260 }, { label: 'Baner', lat: 18.5590, lng: 73.7868 },
  { label: 'Aundh', lat: 18.5580, lng: 73.8075 }, { label: 'Wakad', lat: 18.5975, lng: 73.7602 },
  { label: 'Hinjewadi', lat: 18.5912, lng: 73.7389 },
];
const DEFAULT_LOC = { ...PUNE_AREAS[0], label: 'Deccan Gymkhana' };
const getLoc = () => store.get('loc', DEFAULT_LOC);

// Restaurant banner: real photo when photo_url is set, otherwise a cuisine emoji on a colour gradient
const CUISINE_STYLE = {
  'Mughlai & Biryani': ['🍛', '#f59e0b', '#dc2626'], 'Maharashtrian': ['🥘', '#f97316', '#b91c1c'], 'Irani Cafe': ['☕', '#a16207', '#78350f'],
  'Barbecue & Grill': ['🍢', '#ef4444', '#7f1d1d'], 'Pan-Asian': ['🍜', '#14b8a6', '#0f766e'], 'Chinese': ['🥡', '#ef4444', '#f59e0b'],
  'North Indian': ['🍲', '#f59e0b', '#c2410c'], 'Punjabi': ['🫓', '#eab308', '#c2410c'], 'Malvani Seafood': ['🦐', '#0ea5e9', '#1d4ed8'],
  'Multi-Cuisine': ['🍽️', '#fb923c', '#e11d48'], 'Mexican': ['🌮', '#84cc16', '#dc2626'], 'Italian': ['🍕', '#ef4444', '#16a34a'],
  'South Indian': ['🥞', '#facc15', '#16a34a'], 'Desserts': ['🍰', '#f472b6', '#a855f7'], 'Bakery': ['🥐', '#d97706', '#92400e'],
  'Ice Cream': ['🍨', '#f9a8d4', '#60a5fa'],
};
const cuisineStyle = c => CUISINE_STYLE[c] || ['🍽️', '#fb923c', '#e11d48'];
function banner(r, cls) {
  const [em, c1, c2] = cuisineStyle(r.cuisine_type), g = `linear-gradient(135deg,${c1},${c2})`;
  return `<div class="${cls}" style="background:${r.photo_url ? `url('${esc(r.photo_url)}') center/cover,` : ''}${g}"></div>`;
}
const stars = r => `<span class="pill y">★ ${Number(r.rating).toFixed(1)}</span>`;
const reviews = n => n >= 1000 ? (n / 1000).toFixed(1).replace('.0', '') + 'K' : n;
// ---------- input rules (mirror of backend/validators.js; the server checks everything again) ----------
const PHONE_RE = /^[789][0-9]{9}$/;
const phoneProblem = p => PHONE_RE.test(String(p ?? '').trim()) ? null : 'Phone number must be exactly 10 digits and start with 7, 8 or 9';
const PW_RULES = [['At least 8 characters', p => p.length >= 8], ['An uppercase letter (A-Z)', p => /[A-Z]/.test(p)], ['A lowercase letter (a-z)', p => /[a-z]/.test(p)],
  ['A number (0-9)', p => /[0-9]/.test(p)], ['A special character (@ # $ !)', p => /[^A-Za-z0-9\s]/.test(p)]];
function passwordProblem(pw, ctx = {}) {
  const p = String(pw ?? ''), low = p.toLowerCase(), out = PW_RULES.filter(r => !r[1](p)).map(r => r[0][0].toLowerCase() + r[0].slice(1));
  if (p.length > 64) out.push('at most 64 characters');
  if (/\s/.test(p)) out.push('no spaces');
  if (/(.)\1{3,}/.test(p)) out.push('no character repeated 4 or more times');
  const SEQ = 'abcdefghijklmnopqrstuvwxyz0123456789qwertyuiopasdfghjklzxcvbnm';
  for (let i = 0; i + 4 <= low.length; i++) { const s4 = low.slice(i, i + 4); if (SEQ.includes(s4) || SEQ.includes([...s4].reverse().join(''))) { out.push('no easy sequences like 1234 or abcd'); break; } }
  const COMMON = ['password', 'passw0rd', 'qwerty', 'qwertyuiop', 'letmein', 'welcome', 'admin', 'iloveyou', 'abc123', 'monkey', 'dragon', 'football', 'login', 'princess', 'sunshine', 'master', 'shadow', 'multieats', 'restaurant', 'owner', 'test'];
  if (COMMON.some(w => low.includes(w) && low.length <= w.length + 4)) out.push('not a common password');
  const local = String(ctx.email || '').split('@')[0].toLowerCase();
  if (local.length >= 4 && low.includes(local)) out.push('must not contain your email name');
  if (String(ctx.name || '').toLowerCase().split(/\s+/).some(x => x.length >= 4 && low.includes(x))) out.push('must not contain your name');
  return out.length ? 'Password is too weak. It needs: ' + out.join(', ') : null;
}

// ---------- horizontal bar chart (e.g. "Orders per customer") ----------
function barChart(title, rows, valueKey = 'orders', labelKey = 'name') {
  const max = Math.max(1, ...rows.map(r => +r[valueKey] || 0));
  return `<div class="card pad chart"><h3>${esc(title)}</h3>${rows.length ? rows.map(r =>
    `<div class="bar-row"><span class="bar-label">${esc(r[labelKey])}</span><div class="bar-track"><i style="width:${Math.max(8, (+r[valueKey] || 0) / max * 100)}%"></i></div><b>${+r[valueKey] || 0}</b></div>`).join('')
    : '<div class="empty">No orders yet</div>'}</div>`;
}

async function api(path, opts = {}) {
  const u = getUser(), headers = { 'Content-Type': 'application/json', ...(u && u.token ? { Authorization: 'Bearer ' + u.token } : {}) };
  let r;
  try { r = await fetch(API + path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined }); }
  catch { throw new Error('Cannot reach backend. Is "npm start" running in the backend folder?'); }
  let d = {}; try { d = await r.json(); } catch {}
  if (r.status === 401 && !path.startsWith('/auth/')) {   // login expired: clear it and ask for a fresh login
    store.del('user'); location = 'login.html?next=' + encodeURIComponent(location.pathname.split('/').pop() + location.search);
  }
  if (!r.ok) throw new Error(d.error || 'Request failed');
  return d;
}
function toast(msg, type = 'ok') {
  let t = $('#toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  const e = document.createElement('div'); e.className = 'tst ' + (type === 'ok' ? '' : 'bad'); e.textContent = msg; t.appendChild(e); setTimeout(() => e.remove(), 3800);
}
function nav(active) {
  const u=getUser(), l=(h,t,k)=>`<a class="l ${active===k?'on':''}" href="${h}">${t}</a>`;
  document.body.insertAdjacentHTML('afterbegin', `<nav><div class="in"><a class="brand" href="index.html">🍽️ MultiEats</a>
    ${!u || (!isAdmin() && !isStaff()) ? `${l('index.html','Restaurants','home')}${l('cart.html','Cart<span class="badge" id="cbadge">0</span>','cart')}${l('orders.html','My Orders','orders')}` : ''}${isAdmin()?l('admin.html','Restaurant Panel','admin'):''}${isStaff()?l('owner.html','Restaurant Dashboard','owner'):''}
    ${u ? `<a class="l" href="#" onclick="store.del('user');store.del('cart');location='login.html'">Logout (${esc(u.name.split(' ')[0])})</a>` : l('login.html','Login','login')}</div></nav>`);
  setCart(getCart());
}

function requireCustomer() { const u=getUser(); if(u && (isAdmin() || isStaff())) { location=isAdmin()?'admin.html':'owner.html'; return false; } return true; }
function requireLogin() { if (!getUser()) { location = 'login.html?next=' + encodeURIComponent(location.pathname.split('/').pop() + location.search); return false; } return true; }

// ---------- Smart suggestions (radius + Haversine gap filter) ----------
async function loadSuggestions(el, onAdd) {
  const cart = getCart(); if (!el) return;
  if (!cart.length) { el.innerHTML = ''; return; }
  const loc = getLoc(), radius = store.get('sugRadius', 3), ids = [...new Set(cart.map(i => i.restaurant_id))];
  const chips = [1, 2, 3, 5, 8].map(n => `<button class="chip ${n === radius ? 'on' : ''}" data-r="${n}">${n} km</button>`).join('');
  let list = [];
  try { list = await api(`/restaurants/suggestions?lat=${loc.lat}&lng=${loc.lng}&radius=${radius}&exclude=${ids.join(',')}`); }
  catch (e) { el.innerHTML = `<div class="alert bad">${esc(e.message)}</div>`; return; }
  el.innerHTML = `<div class="sug"><div class="row" style="flex-wrap:wrap"><div><h3 style="margin:0">✨ Add more from nearby — same delivery</h3>
    <div class="muted">Different cuisines within <b>${radius} km</b> of you, close to your cart restaurants</div></div><div class="chips">${chips}</div></div>
    <div class="hscroll">${list.length ? list.map(r => `<div class="scard">${banner(r, 'simg')}
      <div class="sb"><b>${esc(r.name)}</b><div class="muted">${esc(r.cuisine_type)} · ★ ${Number(r.rating).toFixed(1)} (${reviews(r.rating_count)})</div><div class="why">${esc(r.reason)}</div>
      <div style="margin:6px 0"><span class="pill g">📍 ${r.distance_km} km</span> <span class="pill b">↔ ${r.gap_km} km apart</span> <span class="pill">⏱ ${r.eta_min} min</span></div>
      ${r.items.map(i => `<div class="mini"><span><span class="veg ${i.is_veg ? '' : 'nv'}"></span>${esc(i.name)} <span class="muted">${money(i.price)}</span></span>
        <button class="sm" data-add='${JSON.stringify({ item_id: i.item_id, name: i.name, price: i.price, restaurant_id: r.restaurant_id, restaurant_name: r.name }).replace(/'/g, '&#39;')}'>+</button></div>`).join('')}
      <a class="muted" href="restaurant.html?id=${r.restaurant_id}" style="color:var(--brand);font-weight:600">View full menu →</a></div></div>`).join('')
      : `<div class="empty" style="padding:20px">No other restaurants within ${radius} km. Try a bigger radius.</div>`}</div></div>`;
  el.querySelectorAll('[data-r]').forEach(b => b.onclick = () => { store.set('sugRadius', +b.dataset.r); loadSuggestions(el, onAdd); });
  el.querySelectorAll('[data-add]').forEach(b => b.onclick = () => {
    const it = JSON.parse(b.dataset.add), c = getCart(), f = c.find(x => x.item_id === it.item_id);
    f ? f.quantity++ : c.push({ ...it, quantity: 1 }); setCart(c); toast('Item added to cart successfully!'); cartBar();
    onAdd ? onAdd() : loadSuggestions(el, onAdd);
  });
}
// floating cart bar
function cartBar() {
  const c = getCart(); let b = $('#cbar');
  if (!c.length) { if (b) b.remove(); return; }
  if (!b) { b = document.createElement('a'); b.id = 'cbar'; b.href = 'cart.html'; document.body.appendChild(b); }
  const n = c.reduce((s, i) => s + i.quantity, 0), t = c.reduce((s, i) => s + i.price * i.quantity, 0);
  b.innerHTML = `<span>🛒 ${n} item${n > 1 ? 's' : ''} · ${new Set(c.map(i => i.restaurant_id)).size} restaurant(s)</span><b>${money(t)} · View cart →</b>`;
}

// Customers never see "Assign delivery": hide it on every page (restaurant staff still see it)
if (!isStaff()) {
  const hideAssign = () => document.querySelectorAll('button, a').forEach(b => {
    if (/assign/i.test(b.getAttribute('onclick') || '') || /assign.*deliver/i.test(b.textContent)) b.remove();
  });
  document.addEventListener('DOMContentLoaded', () => {
    hideAssign();
    new MutationObserver(hideAssign).observe(document.body, { childList: true, subtree: true });
  });
}