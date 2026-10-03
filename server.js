'use strict';
const http = require('http');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite'); // SQLite intégré à Node 22.5+, aucune dépendance native
const crypto = require('crypto');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const raw = new DatabaseSync(DB_PATH);
raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

// petite couche d'adaptation : undefined -> null, id numériques, transactions
const fix = a => a.map(v => (v === undefined ? null : v));
const db = {
  exec: s => raw.exec(s),
  prepare(sql) {
    const st = raw.prepare(sql);
    return {
      run: (...a) => { const r = st.run(...fix(a)); return { changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) }; },
      get: (...a) => st.get(...fix(a)),
      all: (...a) => st.all(...fix(a))
    };
  },
  transaction(fn) {
    return (...a) => {
      raw.exec('BEGIN');
      try { const r = fn(...a); raw.exec('COMMIT'); return r; }
      catch (e) { raw.exec('ROLLBACK'); throw e; }
    };
  }
};

db.exec(`
CREATE TABLE IF NOT EXISTS restaurants(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, code TEXT UNIQUE NOT NULL,
  currency TEXT DEFAULT '€', created_at INTEGER);
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  name TEXT NOT NULL, role TEXT NOT NULL, secret TEXT NOT NULL,
  UNIQUE(restaurant_id, name));
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER);
CREATE TABLE IF NOT EXISTS categories(
  id INTEGER PRIMARY KEY, restaurant_id INTEGER NOT NULL, name TEXT NOT NULL, position INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS products(
  id INTEGER PRIMARY KEY, restaurant_id INTEGER NOT NULL, category_id INTEGER,
  name TEXT NOT NULL, price_cents INTEGER NOT NULL, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS dining_tables(
  id INTEGER PRIMARY KEY, restaurant_id INTEGER NOT NULL, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY, restaurant_id INTEGER NOT NULL, table_id INTEGER, user_id INTEGER,
  status TEXT DEFAULT 'open', payment_method TEXT, total_cents INTEGER DEFAULT 0,
  created_at INTEGER, paid_at INTEGER);
CREATE TABLE IF NOT EXISTS order_items(
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  restaurant_id INTEGER NOT NULL, product_id INTEGER, name TEXT NOT NULL,
  price_cents INTEGER NOT NULL, qty INTEGER DEFAULT 1, note TEXT DEFAULT '',
  status TEXT DEFAULT 'new', created_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_orders_rest ON orders(restaurant_id, status);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
`);

/* ---------- helpers ---------- */
const now = () => Date.now();
function hashSecret(s) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(String(s), salt, 32).toString('hex');
}
function checkSecret(s, stored) {
  const [salt, hash] = stored.split(':');
  const h = crypto.scryptSync(String(s), salt, 32);
  return crypto.timingSafeEqual(h, Buffer.from(hash, 'hex'));
}
function newCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let c = '';
    for (let i = 0; i < 6; i++) c += chars[crypto.randomInt(chars.length)];
    if (!db.prepare('SELECT 1 FROM restaurants WHERE code=?').get(c)) return c;
  }
}
const clean = (v, max = 80) => String(v ?? '').trim().slice(0, max);
const cents = v => Math.max(0, Math.round(Number(v) || 0));
const newToken = () => crypto.randomBytes(9).toString('base64url'); // jeton secret d'une table (QR code)

/* ---------- migrations (bases créées avant la commande par QR code) ---------- */
function addColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('dining_tables', 'qr_token', 'TEXT');
addColumn('restaurants', 'customer_mode', "TEXT DEFAULT 'validate'"); // off | validate | direct
addColumn('order_items', 'source', "TEXT DEFAULT 'staff'");
addColumn('order_items', 'client_id', 'TEXT');
addColumn('order_items', 'ready_at', 'INTEGER'); // moment où la cuisine a déclaré le plat prêt
addColumn('order_items', 'picked_by', 'TEXT');   // serveur qui va chercher le plat
for (const t of db.prepare('SELECT id FROM dining_tables WHERE qr_token IS NULL').all())
  db.prepare('UPDATE dining_tables SET qr_token=? WHERE id=?').run(newToken(), t.id);

/* ---------- real time (SSE) ---------- */
const clients = new Map(); // restaurantId -> Set(res)
function broadcast(rid, type = 'update', data) {
  const set = clients.get(rid);
  if (!set) return;
  const payload = data === undefined ? Date.now() : JSON.stringify(data);
  for (const res of set) res.write(`event: ${type}\ndata: ${payload}\n\n`);
}

/* ---------- app ---------- */
// Mini routeur (zéro dépendance) : même style que Express
const routes = [];
const route = method => (p, ...fns) => {
  const keys = [];
  const re = new RegExp('^' + p.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, fns });
};
const app = { get: route('GET'), post: route('POST'), put: route('PUT'), patch: route('PATCH'), delete: route('DELETE') };

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon'
};
const PUBLIC = path.join(__dirname, 'public');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 200 * 1024) { reject(new Error('too big')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  let rel = decodeURIComponent(req.path);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.statusCode = 403; return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.statusCode = 404; return res.end('Introuvable'); }
    res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
    if (rel === '/sw.js') res.setHeader('Cache-Control', 'no-cache');
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  req.path = url.pathname;
  req.query = Object.fromEntries(url.searchParams);
  req.ip = (process.env.TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress;
  res.status = c => { res.statusCode = c; return res; };
  res.json = o => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(o)); return res; };
  res.set = h => { for (const k in h) res.setHeader(k, h[k]); return res; };
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer'); // le jeton de table est dans l'URL du QR code

  try {
    if (!req.path.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; return res.end(); }
      // lien court des QR codes : /c/CODE_RESTAURANT/JETON_TABLE -> page de commande client
      if (/^\/c\/[^/]+\/[^/]+\/?$/.test(req.path)) req.path = '/commande.html';
      return serveStatic(req, res);
    }
    req.body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(req.path);
      if (!m) continue;
      req.params = {};
      r.keys.forEach((k, i) => (req.params[k] = decodeURIComponent(m[i + 1])));
      let i = 0;
      const next = () => { const fn = r.fns[i++]; if (fn) fn(req, res, next); };
      return next();
    }
    res.status(404).json({ error: 'Route inconnue' });
  } catch (err) {
    if (err.message === 'bad json' || err.message === 'too big') return res.status(400).json({ error: 'Requête invalide' });
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Erreur serveur' });
    else res.end();
  }
});

// simple login rate limit
const fails = new Map();
function limited(key) {
  const f = fails.get(key);
  return f && f.count >= 8 && now() - f.t < 10 * 60 * 1000;
}
function noteFail(key) {
  const f = fails.get(key);
  if (!f || now() - f.t > 10 * 60 * 1000) fails.set(key, { count: 1, t: now() });
  else f.count++;
}

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : req.query.token;
  const row = token && db.prepare(
    `SELECT u.id, u.name, u.role, u.restaurant_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?`
  ).get(token);
  if (!row) return res.status(401).json({ error: 'Non connecté' });
  req.user = row;
  req.rid = row.restaurant_id;
  next();
}
const owner = (req, res, next) =>
  req.user.role === 'owner' ? next() : res.status(403).json({ error: 'Réservé au gérant' });
const notKitchen = (req, res, next) =>
  req.user.role === 'kitchen' ? res.status(403).json({ error: 'Interdit' }) : next();

function startSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token,user_id,created_at) VALUES(?,?,?)').run(token, userId, now());
  return token;
}

/* ---------- auth ---------- */
app.post('/api/register', (req, res) => {
  const name = clean(req.body.restaurant);
  const user = clean(req.body.name, 40);
  const secret = String(req.body.secret || '');
  if (!name || !user) return res.status(400).json({ error: 'Nom du restaurant et du gérant requis' });
  if (secret.length < 6) return res.status(400).json({ error: 'Mot de passe : 6 caractères minimum' });
  const code = newCode();
  const tx = db.transaction(() => {
    const rid = db.prepare('INSERT INTO restaurants(name,code,created_at) VALUES(?,?,?)').run(name, code, now()).lastInsertRowid;
    const uid = db.prepare('INSERT INTO users(restaurant_id,name,role,secret) VALUES(?,?,?,?)')
      .run(rid, user, 'owner', hashSecret(secret)).lastInsertRowid;
    // demo data so the app is usable immediately
    const addCat = db.prepare('INSERT INTO categories(restaurant_id,name,position) VALUES(?,?,?)');
    const addProd = db.prepare('INSERT INTO products(restaurant_id,category_id,name,price_cents) VALUES(?,?,?,?)');
    const c1 = addCat.run(rid, 'Entrées', 1).lastInsertRowid;
    const c2 = addCat.run(rid, 'Plats', 2).lastInsertRowid;
    const c3 = addCat.run(rid, 'Desserts', 3).lastInsertRowid;
    const c4 = addCat.run(rid, 'Boissons', 4).lastInsertRowid;
    [['Salade verte', 650], ['Soupe du jour', 700]].forEach(([n, p]) => addProd.run(rid, c1, n, p));
    [['Burger maison', 1400], ['Pizza margherita', 1100], ['Pâtes carbonara', 1250]].forEach(([n, p]) => addProd.run(rid, c2, n, p));
    [['Tiramisu', 650], ['Glace 2 boules', 500]].forEach(([n, p]) => addProd.run(rid, c3, n, p));
    [['Eau 50cl', 300], ['Soda', 350], ['Café', 250], ['Bière', 500]].forEach(([n, p]) => addProd.run(rid, c4, n, p));
    const addT = db.prepare('INSERT INTO dining_tables(restaurant_id,name,qr_token) VALUES(?,?,?)');
    for (let i = 1; i <= 8; i++) addT.run(rid, 'Table ' + i, newToken());
    return uid;
  });
  const uid = tx();
  res.json({ token: startSession(uid), code });
});

app.post('/api/login', (req, res) => {
  const code = clean(req.body.code, 10).toUpperCase();
  const name = clean(req.body.name, 40);
  const key = req.ip + ':' + code;
  if (limited(key)) return res.status(429).json({ error: 'Trop d\'essais, réessayez dans 10 minutes' });
  const r = db.prepare('SELECT id FROM restaurants WHERE code=?').get(code);
  const u = r && db.prepare('SELECT * FROM users WHERE restaurant_id=? AND name=? COLLATE NOCASE').get(r.id, name);
  if (!u || !checkSecret(req.body.secret || '', u.secret)) {
    noteFail(key);
    return res.status(401).json({ error: 'Identifiants incorrects' });
  }
  res.json({ token: startSession(u.id) });
});

app.post('/api/logout', auth, (req, res) => {
  const h = req.headers.authorization || '';
  db.prepare('DELETE FROM sessions WHERE token=?').run(h.slice(7));
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  const r = db.prepare('SELECT name, code, currency, customer_mode FROM restaurants WHERE id=?').get(req.rid);
  res.json({ user: { id: req.user.id, name: req.user.name, role: req.user.role }, restaurant: r });
});

/* ---------- real-time stream ---------- */
app.get('/api/events', auth, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  if (!clients.has(req.rid)) clients.set(req.rid, new Set());
  clients.get(req.rid).add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    clients.get(req.rid)?.delete(res);
  });
});

/* ---------- menu & tables (generic CRUD) ---------- */
app.get('/api/menu', auth, (req, res) => {
  res.json({
    categories: db.prepare('SELECT * FROM categories WHERE restaurant_id=? ORDER BY position,id').all(req.rid),
    products: db.prepare('SELECT * FROM products WHERE restaurant_id=? ORDER BY name').all(req.rid),
    // le jeton du QR code n'est visible que par le gérant
    tables: db.prepare('SELECT id, restaurant_id, name, qr_token FROM dining_tables WHERE restaurant_id=? ORDER BY id').all(req.rid)
      .map(t => (req.user.role === 'owner' ? t : { id: t.id, restaurant_id: t.restaurant_id, name: t.name }))
  });
});

app.put('/api/settings', auth, owner, (req, res) => {
  const mode = ['off', 'validate', 'direct'].includes(req.body.customer_mode) ? req.body.customer_mode : null;
  if (!mode) return res.status(400).json({ error: 'Mode invalide' });
  db.prepare('UPDATE restaurants SET customer_mode=? WHERE id=?').run(mode, req.rid);
  res.json({ ok: true, customer_mode: mode });
});

app.post('/api/categories', auth, owner, (req, res) => {
  const name = clean(req.body.name);
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  const pos = db.prepare('SELECT COALESCE(MAX(position),0)+1 p FROM categories WHERE restaurant_id=?').get(req.rid).p;
  db.prepare('INSERT INTO categories(restaurant_id,name,position) VALUES(?,?,?)').run(req.rid, name, pos);
  broadcast(req.rid, 'menu');
  res.json({ ok: true });
});
app.delete('/api/categories/:id', auth, owner, (req, res) => {
  db.prepare('DELETE FROM products WHERE category_id=? AND restaurant_id=?').run(req.params.id, req.rid);
  db.prepare('DELETE FROM categories WHERE id=? AND restaurant_id=?').run(req.params.id, req.rid);
  broadcast(req.rid, 'menu');
  res.json({ ok: true });
});

app.post('/api/products', auth, owner, (req, res) => {
  const name = clean(req.body.name);
  const cat = db.prepare('SELECT id FROM categories WHERE id=? AND restaurant_id=?').get(req.body.category_id, req.rid);
  if (!name || !cat) return res.status(400).json({ error: 'Nom et catégorie requis' });
  db.prepare('INSERT INTO products(restaurant_id,category_id,name,price_cents) VALUES(?,?,?,?)')
    .run(req.rid, cat.id, name, cents(req.body.price_cents));
  broadcast(req.rid, 'menu');
  res.json({ ok: true });
});
app.put('/api/products/:id', auth, owner, (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id=? AND restaurant_id=?').get(req.params.id, req.rid);
  if (!p) return res.status(404).json({ error: 'Introuvable' });
  db.prepare('UPDATE products SET name=?, price_cents=?, active=? WHERE id=?').run(
    clean(req.body.name ?? p.name), req.body.price_cents == null ? p.price_cents : cents(req.body.price_cents),
    req.body.active == null ? p.active : (req.body.active ? 1 : 0), p.id);
  broadcast(req.rid, 'menu');
  res.json({ ok: true });
});
app.delete('/api/products/:id', auth, owner, (req, res) => {
  db.prepare('DELETE FROM products WHERE id=? AND restaurant_id=?').run(req.params.id, req.rid);
  broadcast(req.rid, 'menu');
  res.json({ ok: true });
});

app.post('/api/tables', auth, owner, (req, res) => {
  const name = clean(req.body.name, 30);
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  db.prepare('INSERT INTO dining_tables(restaurant_id,name,qr_token) VALUES(?,?,?)').run(req.rid, name, newToken());
  broadcast(req.rid, 'menu');
  res.json({ ok: true });
});
// change le jeton : l'ancien QR code (imprimé ou photographié) ne fonctionne plus
app.post('/api/tables/regenerate-all', auth, owner, (req, res) => {
  for (const t of db.prepare('SELECT id FROM dining_tables WHERE restaurant_id=?').all(req.rid))
    db.prepare('UPDATE dining_tables SET qr_token=? WHERE id=?').run(newToken(), t.id);
  broadcast(req.rid, 'menu');
  res.json({ ok: true });
});
app.post('/api/tables/:id/regenerate', auth, owner, (req, res) => {
  db.prepare('UPDATE dining_tables SET qr_token=? WHERE id=? AND restaurant_id=?').run(newToken(), req.params.id, req.rid);
  broadcast(req.rid, 'menu');
  res.json({ ok: true });
});
app.delete('/api/tables/:id', auth, owner, (req, res) => {
  const open = db.prepare("SELECT 1 FROM orders WHERE table_id=? AND restaurant_id=? AND status='open'").get(req.params.id, req.rid);
  if (open) return res.status(400).json({ error: 'Une commande est ouverte sur cette table' });
  db.prepare('DELETE FROM dining_tables WHERE id=? AND restaurant_id=?').run(req.params.id, req.rid);
  broadcast(req.rid, 'menu');
  res.json({ ok: true });
});

/* ---------- staff ---------- */
app.get('/api/users', auth, owner, (req, res) => {
  res.json(db.prepare('SELECT id,name,role FROM users WHERE restaurant_id=? ORDER BY id').all(req.rid));
});
app.post('/api/users', auth, owner, (req, res) => {
  const name = clean(req.body.name, 40);
  const role = ['waiter', 'kitchen', 'owner'].includes(req.body.role) ? req.body.role : 'waiter';
  const secret = String(req.body.secret || '');
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  if (secret.length < 4) return res.status(400).json({ error: 'Code : 4 caractères minimum' });
  try {
    db.prepare('INSERT INTO users(restaurant_id,name,role,secret) VALUES(?,?,?,?)').run(req.rid, name, role, hashSecret(secret));
  } catch {
    return res.status(400).json({ error: 'Ce nom existe déjà' });
  }
  res.json({ ok: true });
});
app.delete('/api/users/:id', auth, owner, (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'Vous ne pouvez pas vous supprimer' });
  db.prepare('DELETE FROM users WHERE id=? AND restaurant_id=?').run(req.params.id, req.rid);
  res.json({ ok: true });
});

/* ---------- orders ---------- */
function getOrder(rid, id) {
  const o = db.prepare('SELECT o.*, t.name table_name, u.name waiter FROM orders o LEFT JOIN dining_tables t ON t.id=o.table_id LEFT JOIN users u ON u.id=o.user_id WHERE o.id=? AND o.restaurant_id=?').get(id, rid);
  if (!o) return null;
  o.items = db.prepare("SELECT * FROM order_items WHERE order_id=? AND status<>'refused' ORDER BY id").all(id);
  // les demandes clients en attente de validation ne comptent pas encore dans le total
  if (o.status === 'open') o.total_cents = o.items.filter(i => i.status !== 'pending').reduce((s, i) => s + i.price_cents * i.qty, 0);
  return o;
}

app.get('/api/orders/open', auth, notKitchen, (req, res) => {
  const rows = db.prepare(`
    SELECT o.id, o.table_id, o.created_at,
      COALESCE((SELECT SUM(price_cents*qty) FROM order_items WHERE order_id=o.id AND status NOT IN ('pending','refused')),0) total_cents,
      COALESCE((SELECT COUNT(*) FROM order_items WHERE order_id=o.id AND status='ready'),0) ready_count,
      COALESCE((SELECT COUNT(*) FROM order_items WHERE order_id=o.id AND status='pending'),0) pending_count
    FROM orders o WHERE o.restaurant_id=? AND o.status='open'`).all(req.rid);
  res.json(rows);
});

app.post('/api/orders', auth, notKitchen, (req, res) => {
  const t = db.prepare('SELECT id FROM dining_tables WHERE id=? AND restaurant_id=?').get(req.body.table_id, req.rid);
  if (!t) return res.status(400).json({ error: 'Table invalide' });
  let o = db.prepare("SELECT id FROM orders WHERE table_id=? AND restaurant_id=? AND status='open'").get(t.id, req.rid);
  if (!o) {
    const id = db.prepare('INSERT INTO orders(restaurant_id,table_id,user_id,created_at) VALUES(?,?,?,?)').run(req.rid, t.id, req.user.id, now()).lastInsertRowid;
    o = { id };
    broadcast(req.rid);
  }
  res.json(getOrder(req.rid, o.id));
});

app.get('/api/orders/:id', auth, notKitchen, (req, res) => {
  const o = getOrder(req.rid, req.params.id);
  o ? res.json(o) : res.status(404).json({ error: 'Introuvable' });
});

app.post('/api/orders/:id/items', auth, notKitchen, (req, res) => {
  const o = getOrder(req.rid, req.params.id);
  if (!o || o.status !== 'open') return res.status(400).json({ error: 'Commande fermée' });
  const p = db.prepare('SELECT * FROM products WHERE id=? AND restaurant_id=? AND active=1').get(req.body.product_id, req.rid);
  if (!p) return res.status(400).json({ error: 'Produit invalide' });
  const qty = Math.min(99, Math.max(1, parseInt(req.body.qty) || 1));
  const note = clean(req.body.note, 120);
  // merge with an identical not-yet-sent line
  const same = db.prepare("SELECT id FROM order_items WHERE order_id=? AND product_id=? AND status='new' AND note=?").get(o.id, p.id, note);
  if (same) db.prepare('UPDATE order_items SET qty=qty+? WHERE id=?').run(qty, same.id);
  else db.prepare('INSERT INTO order_items(order_id,restaurant_id,product_id,name,price_cents,qty,note,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(o.id, req.rid, p.id, p.name, p.price_cents, qty, note, now());
  broadcast(req.rid);
  res.json(getOrder(req.rid, o.id));
});

app.patch('/api/items/:id', auth, (req, res) => {
  const it = db.prepare('SELECT * FROM order_items WHERE id=? AND restaurant_id=?').get(req.params.id, req.rid);
  if (!it) return res.status(404).json({ error: 'Introuvable' });
  let readyEvt = null;
  if (req.body.status) {
    const s = req.body.status;
    if (it.status === 'pending') {
      // une demande client ne peut être qu'acceptée ou refusée, par le personnel de salle
      if (req.user.role === 'kitchen' || !['sent', 'refused'].includes(s)) return res.status(400).json({ error: 'Statut invalide' });
    } else if (!['sent', 'preparing', 'ready', 'served'].includes(s)) return res.status(400).json({ error: 'Statut invalide' });
    db.prepare('UPDATE order_items SET status=? WHERE id=?').run(s, it.id);
    if (s === 'ready' && it.status !== 'ready') {
      // plat prêt : on note l'heure et on prévient les serveurs en direct
      db.prepare('UPDATE order_items SET ready_at=?, picked_by=NULL WHERE id=?').run(now(), it.id);
      const t = db.prepare('SELECT t.name FROM orders o LEFT JOIN dining_tables t ON t.id=o.table_id WHERE o.id=?').get(it.order_id);
      readyEvt = { item_id: it.id, order_id: it.order_id, table: (t && t.name) || '', name: it.name, qty: it.qty };
    }
  }
  if (req.body.pickup) {
    // un serveur indique qu'il va chercher le plat (évite que deux serveurs y aillent)
    if (req.user.role === 'kitchen') return res.status(403).json({ error: 'Interdit' });
    if (it.status !== 'ready') return res.status(400).json({ error: 'Ce plat n\'est pas (ou plus) à servir' });
    db.prepare('UPDATE order_items SET picked_by=? WHERE id=?').run(req.user.name, it.id);
  }
  if (req.body.qty != null) {
    if (req.user.role === 'kitchen') return res.status(403).json({ error: 'Interdit' });
    if (it.status !== 'new' && req.user.role !== 'owner') return res.status(400).json({ error: 'Déjà envoyé en cuisine' });
    const q = parseInt(req.body.qty);
    if (q <= 0) db.prepare('DELETE FROM order_items WHERE id=?').run(it.id);
    else db.prepare('UPDATE order_items SET qty=? WHERE id=?').run(Math.min(99, q), it.id);
  }
  broadcast(req.rid);
  if (readyEvt) broadcast(req.rid, 'ready', readyEvt);
  res.json(getOrder(req.rid, it.order_id));
});

app.post('/api/orders/:id/send', auth, notKitchen, (req, res) => {
  const o = getOrder(req.rid, req.params.id);
  if (!o) return res.status(404).json({ error: 'Introuvable' });
  db.prepare("UPDATE order_items SET status='sent' WHERE order_id=? AND status='new'").run(o.id);
  broadcast(req.rid);
  res.json(getOrder(req.rid, o.id));
});

// accepter ou refuser toutes les demandes clients en attente d'une commande
app.post('/api/orders/:id/pending', auth, notKitchen, (req, res) => {
  const o = getOrder(req.rid, req.params.id);
  if (!o || o.status !== 'open') return res.status(400).json({ error: 'Commande fermée' });
  if (!['accept', 'refuse'].includes(req.body.action)) return res.status(400).json({ error: 'Action invalide' });
  db.prepare("UPDATE order_items SET status=? WHERE order_id=? AND status='pending'")
    .run(req.body.action === 'accept' ? 'sent' : 'refused', o.id);
  broadcast(req.rid);
  res.json(getOrder(req.rid, o.id));
});

app.post('/api/orders/:id/pay', auth, notKitchen, (req, res) => {
  const o = getOrder(req.rid, req.params.id);
  if (!o || o.status !== 'open') return res.status(400).json({ error: 'Commande fermée' });
  if (o.items.some(i => i.status === 'pending')) return res.status(400).json({ error: 'Des demandes clients attendent votre réponse (accepter ou refuser)' });
  if (!o.items.length) return res.status(400).json({ error: 'Commande vide' });
  const method = ['cash', 'card', 'other'].includes(req.body.method) ? req.body.method : 'cash';
  db.prepare("UPDATE orders SET status='paid', payment_method=?, total_cents=?, paid_at=? WHERE id=?").run(method, o.total_cents, now(), o.id);
  db.prepare("UPDATE order_items SET status='served' WHERE order_id=? AND status<>'refused'").run(o.id);
  broadcast(req.rid);
  res.json(getOrder(req.rid, o.id));
});

app.post('/api/orders/:id/cancel', auth, notKitchen, (req, res) => {
  const o = getOrder(req.rid, req.params.id);
  if (!o || o.status !== 'open') return res.status(400).json({ error: 'Commande fermée' });
  if (o.items.some(i => !['new', 'pending'].includes(i.status)) && req.user.role !== 'owner')
    return res.status(403).json({ error: 'Seul le gérant peut annuler une commande envoyée' });
  db.prepare("UPDATE orders SET status='cancelled' WHERE id=?").run(o.id);
  broadcast(req.rid);
  res.json({ ok: true });
});

/* ---------- kitchen ---------- */
app.get('/api/kitchen', auth, (req, res) => {
  const items = db.prepare(`
    SELECT i.*, o.table_id, t.name table_name, o.id order_id
    FROM order_items i JOIN orders o ON o.id=i.order_id
    LEFT JOIN dining_tables t ON t.id=o.table_id
    WHERE i.restaurant_id=? AND o.status='open' AND i.status IN ('sent','preparing','ready')
    ORDER BY i.created_at, i.id`).all(req.rid);
  res.json(items);
});

// plats prêts en attente d'être servis (bandeau d'alerte des serveurs)
app.get('/api/ready', auth, notKitchen, (req, res) => {
  res.json(db.prepare(`
    SELECT i.id, i.order_id, i.name, i.qty, i.note, i.ready_at, i.picked_by, t.name table_name
    FROM order_items i JOIN orders o ON o.id=i.order_id
    LEFT JOIN dining_tables t ON t.id=o.table_id
    WHERE i.restaurant_id=? AND o.status='open' AND i.status='ready'
    ORDER BY i.ready_at, i.id`).all(req.rid));
});

/* ---------- reports ---------- */
app.get('/api/reports', auth, owner, (req, res) => {
  const day = 86400000;
  const from = Number(req.query.from) || Date.now() - 7 * day;
  const to = Number(req.query.to) || Date.now();
  const sum = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(total_cents),0) total FROM orders WHERE restaurant_id=? AND status='paid' AND paid_at BETWEEN ? AND ?").get(req.rid, from, to);
  const byMethod = db.prepare("SELECT payment_method m, COUNT(*) n, SUM(total_cents) total FROM orders WHERE restaurant_id=? AND status='paid' AND paid_at BETWEEN ? AND ? GROUP BY payment_method").all(req.rid, from, to);
  const top = db.prepare(`SELECT i.name, SUM(i.qty) qty, SUM(i.qty*i.price_cents) total
    FROM order_items i JOIN orders o ON o.id=i.order_id
    WHERE o.restaurant_id=? AND o.status='paid' AND o.paid_at BETWEEN ? AND ?
      AND i.status NOT IN ('refused','pending')
    GROUP BY i.name ORDER BY qty DESC LIMIT 10`).all(req.rid, from, to);
  const perDay = db.prepare(`SELECT date(paid_at/1000,'unixepoch','localtime') d, COUNT(*) n, SUM(total_cents) total
    FROM orders WHERE restaurant_id=? AND status='paid' AND paid_at BETWEEN ? AND ? GROUP BY d ORDER BY d`).all(req.rid, from, to);
  res.json({ ...sum, avg: sum.n ? Math.round(sum.total / sum.n) : 0, byMethod, top, perDay });
});

/* ---------- commande par les clients (QR code / lien de table) ---------- */
// Pas de compte : l'accès se fait avec le code du restaurant + le jeton secret de la table.
const pubHits = new Map();
function pubLimited(key, max, windowMs) {
  const t = now();
  const hits = (pubHits.get(key) || []).filter(x => t - x < windowMs);
  const blocked = hits.length >= max;
  if (!blocked) hits.push(t);
  pubHits.set(key, hits);
  return blocked;
}
setInterval(() => pubHits.clear(), 3600000);

function resolveTable(r, t) {
  const resto = db.prepare('SELECT id, name, currency, customer_mode FROM restaurants WHERE code=?').get(clean(r, 10).toUpperCase());
  const table = resto && db.prepare('SELECT id, name FROM dining_tables WHERE restaurant_id=? AND qr_token=?').get(resto.id, clean(t, 40));
  return table ? { resto, table } : null;
}

app.get('/api/public/menu', (req, res) => {
  if (pubLimited('m:' + req.ip, 120, 60000)) return res.status(429).json({ error: 'Trop de requêtes' });
  const x = resolveTable(req.query.r, req.query.t);
  if (!x) return res.status(404).json({ error: 'QR code invalide ou expiré. Demandez un serveur.' });
  res.json({
    restaurant: { name: x.resto.name, currency: x.resto.currency },
    table: { name: x.table.name },
    mode: x.resto.customer_mode,
    categories: db.prepare('SELECT id, name FROM categories WHERE restaurant_id=? ORDER BY position, id').all(x.resto.id),
    products: db.prepare('SELECT id, category_id, name, price_cents FROM products WHERE restaurant_id=? AND active=1 ORDER BY name').all(x.resto.id)
  });
});

app.post('/api/public/orders', (req, res) => {
  const x = resolveTable(req.body.r, req.body.t);
  if (!x) return res.status(404).json({ error: 'QR code invalide ou expiré. Demandez un serveur.' });
  if (x.resto.customer_mode === 'off') return res.status(403).json({ error: 'La commande depuis la table n\'est pas activée. Appelez un serveur.' });
  if (pubLimited('o:' + req.ip + ':' + x.table.id, 10, 600000)) return res.status(429).json({ error: 'Trop de commandes envoyées. Appelez un serveur.' });
  const client = clean(req.body.client, 40);
  if (!client) return res.status(400).json({ error: 'Requête invalide' });
  const lines = Array.isArray(req.body.items) ? req.body.items.slice(0, 30) : [];
  if (!lines.length) return res.status(400).json({ error: 'Panier vide' });

  const getProd = db.prepare('SELECT id, name, price_cents FROM products WHERE id=? AND restaurant_id=? AND active=1');
  const checked = [];
  for (const l of lines) {
    const p = getProd.get(l && l.product_id, x.resto.id);
    if (!p) return res.status(400).json({ error: 'Un produit n\'est plus disponible, rechargez la page' });
    checked.push({ p, qty: Math.min(20, Math.max(1, parseInt(l.qty) || 1)), note: clean(l.note, 120) });
  }

  const status = x.resto.customer_mode === 'direct' ? 'sent' : 'pending';
  const tx = db.transaction(() => {
    let o = db.prepare("SELECT id FROM orders WHERE table_id=? AND restaurant_id=? AND status='open'").get(x.table.id, x.resto.id);
    if (!o) o = { id: db.prepare('INSERT INTO orders(restaurant_id,table_id,user_id,created_at) VALUES(?,?,?,?)').run(x.resto.id, x.table.id, null, now()).lastInsertRowid };
    const pend = db.prepare("SELECT COUNT(*) n FROM order_items WHERE order_id=? AND status='pending'").get(o.id).n;
    if (pend >= 60) return false;
    for (const c of checked)
      db.prepare("INSERT INTO order_items(order_id,restaurant_id,product_id,name,price_cents,qty,note,status,created_at,source,client_id) VALUES(?,?,?,?,?,?,?,?,?,'customer',?)")
        .run(o.id, x.resto.id, c.p.id, c.p.name, c.p.price_cents, c.qty, c.note, status, now(), client);
    return true;
  });
  if (!tx()) return res.status(429).json({ error: 'Trop de demandes en attente. Appelez un serveur.' });
  broadcast(x.resto.id, 'customer');
  res.json({ ok: true, status });
});

// suivi : un client ne voit que ce qu'il a commandé depuis son propre appareil
app.get('/api/public/orders', (req, res) => {
  if (pubLimited('g:' + req.ip, 120, 60000)) return res.status(429).json({ error: 'Trop de requêtes' });
  const x = resolveTable(req.query.r, req.query.t);
  if (!x) return res.status(404).json({ error: 'QR code invalide ou expiré' });
  const client = clean(req.query.client, 40);
  const items = client ? db.prepare(`SELECT i.id, i.name, i.qty, i.note, i.price_cents, i.status
    FROM order_items i JOIN orders o ON o.id=i.order_id
    WHERE o.restaurant_id=? AND o.table_id=? AND o.status='open' AND i.client_id=? ORDER BY i.id`).all(x.resto.id, x.table.id, client) : [];
  res.json({ items });
});

// purge old sessions (30 days)
setInterval(() => db.prepare('DELETE FROM sessions WHERE created_at < ?').run(now() - 30 * 86400000), 3600000);

server.listen(PORT, () => console.log(`Resto POS en ligne sur http://localhost:${PORT}`));
