const express  = require('express');
const session  = require('express-session');
const bcrypt   = require('bcryptjs');
const path     = require('path');
const fs       = require('fs');
const multer   = require('multer');
const Database = require('better-sqlite3');

const app     = express();
const PORT    = process.env.PORT || 3000;
const SECRET  = process.env.SESSION_SECRET || 'vendordash-secret-change-this';
const DB_PATH = process.env.DB_PATH || './data.db';

// Uploads directory — co-located with DB so it lives on the persistent volume
const UPLOADS_DIR = process.env.UPLOADS_DIR ||
  path.join(path.dirname(path.resolve(DB_PATH)), 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ─────────────────────────────────────────────────────────
//  DATABASE SETUP
// ─────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT DEFAULT 'staff',
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pdc_cheques (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    date       TEXT NOT NULL,
    vendor     TEXT NOT NULL,
    cheque_no  TEXT,
    amount     REAL NOT NULL,
    status     TEXT DEFAULT 'Pending',
    paid_at    TEXT,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS vendor_demands (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor     TEXT NOT NULL,
    amount     REAL NOT NULL,
    priority   TEXT DEFAULT 'Medium',
    status     TEXT DEFAULT 'Urgent',
    updated_by TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS cash_vendors (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor     TEXT NOT NULL,
    date       TEXT,
    amount     REAL NOT NULL,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS upcoming_expenses (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    description TEXT NOT NULL,
    amount      REAL NOT NULL,
    category    TEXT DEFAULT 'General',
    due_date    TEXT,
    status      TEXT DEFAULT 'Pending',
    paid_at     TEXT,
    created_by  TEXT,
    created_at  TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS refunds (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    order_number     TEXT,
    customer_phone   TEXT,
    amount           REAL NOT NULL,
    notes            TEXT,
    status           TEXT DEFAULT 'Pending',
    attachment_path  TEXT,
    attachment_name  TEXT,
    paid_at          TEXT,
    created_by       TEXT,
    created_at       TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS daily_notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    date       TEXT UNIQUE NOT NULL,
    notes      TEXT DEFAULT '',
    updated_by TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// ── Migrations ────────────────────────────────────────────
// 1. Rename historical_unpaid → cash_vendors (one-time)
try {
  const cols = db.prepare('PRAGMA table_info(historical_unpaid)').all();
  if (cols.length > 0) {
    db.exec(`
      INSERT OR IGNORE INTO cash_vendors (id, vendor, date, amount, created_by, created_at)
        SELECT id, vendor, date, amount, created_by, created_at FROM historical_unpaid;
      DROP TABLE IF EXISTS historical_unpaid;
    `);
    console.log('✅ Migrated historical_unpaid → cash_vendors');
  }
} catch(e) { /* already migrated */ }

// 2. Add paid_at column to pdc_cheques if upgrading
try { db.exec('ALTER TABLE pdc_cheques ADD COLUMN paid_at TEXT'); } catch(e) {}

// ── Seed default users ────────────────────────────────────
const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get();
if (userCount.c === 0) {
  db.prepare('INSERT INTO users (username,password_hash,role) VALUES (?,?,?)')
    .run('admin', bcrypt.hashSync('admin123', 10), 'admin');
  db.prepare('INSERT INTO users (username,password_hash,role) VALUES (?,?,?)')
    .run('team',  bcrypt.hashSync('team123',  10), 'staff');
  console.log('✅ Default users: admin/admin123  and  team/team123');
}

// ── Seed initial PDC data ─────────────────────────────────
const pdcCount = db.prepare('SELECT COUNT(*) as c FROM pdc_cheques').get();
if (pdcCount.c === 0) {
  const ins = db.prepare('INSERT INTO pdc_cheques (date,vendor,cheque_no,amount) VALUES (?,?,?,?)');
  [
    ['2026-04-14','BONITA',        '10018900',151595],
    ['2026-04-14','MAXITECH',      '10018911', 97166],
    ['2026-04-14','HEALTH SERVING','10018914', 74321],
    ['2026-04-14','ASRA DERM',     '10018918',125365],
    ['2026-04-21','WISDOM',        '10018923', 52004],
    ['2026-04-21','MAXITECH',      '10018928', 83086],
    ['2026-04-28','TRANS ASIAN',   '10018910', 45962],
    ['2026-04-28','KALOOS',        '10018917', 26303],
    ['2026-04-28','JENPHARM',      '10018925',150767],
    ['2026-04-28','SAFFRIN',       '10018935', 51644],
    ['2026-05-05','MAZTON',        '10018932', 57161],
    ['2026-05-05','ASRA DERM',     '10018931',280562],
    ['2026-05-12','HEALTH SERVING','10018915',117628],
    ['2026-05-12','DERMOLOGICS',   '10018934', 60476],
    ['2026-05-21','MAZTON',        '10018933', 41658],
  ].forEach(r => ins.run(...r));
  console.log('✅ PDC cheques seeded');
}

const demCount = db.prepare('SELECT COUNT(*) as c FROM vendor_demands').get();
if (demCount.c === 0) {
  const ins = db.prepare('INSERT INTO vendor_demands (vendor,amount,priority) VALUES (?,?,?)');
  [
    ['ZAM ZAM',      298000,'High'],
    ['HEALER',       240000,'High'],
    ['WHIZ',         193000,'Medium'],
    ['SKIN ALLIANCE', 50000,'Low'],
    ['BIONNEX',       45345,'Low'],
  ].forEach(r => ins.run(...r));
}

const cashCount = db.prepare('SELECT COUNT(*) as c FROM cash_vendors').get();
if (cashCount.c === 0) {
  const ins = db.prepare('INSERT INTO cash_vendors (vendor,date,amount) VALUES (?,?,?)');
  [
    ['PHARMA HEALTH','08-04-2026',50000],
    ['HORIZON',      '06-04-2026',45000],
    ['DEU TEC',      '30-03-2026',28000],
    ['QADRI',        '28-03-2026',20000],
    ['BUTIFYR',      '01-04-2026',20000],
    ['GRAVIS',       '27-03-2026', 7000],
  ].forEach(r => ins.run(...r));
}

// ─────────────────────────────────────────────────────────
//  FILE UPLOAD (Multer)
// ─────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `ref_${Date.now()}_${Math.random().toString(36).slice(2,8)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg','.jpeg','.png','.gif','.webp','.pdf'];
    const ext = path.extname(file.originalname).toLowerCase();
    allowed.includes(ext) ? cb(null, true) : cb(new Error('Only images (JPG/PNG/GIF/WebP) and PDF allowed'));
  }
});

// ─────────────────────────────────────────────────────────
//  MIDDLEWARE
// ─────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 } // 8 hours
}));

// Auth guards
const requireAuth    = (req, res, next) => req.session?.userId ? next() : res.redirect('/login');
const requireAuthAPI = (req, res, next) => req.session?.userId ? next() : res.status(401).json({ error: 'Not authenticated' });
const requireAdmin   = (req, res, next) => req.session?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only' });

// ─────────────────────────────────────────────────────────
//  PAGE ROUTES — all require login
// ─────────────────────────────────────────────────────────
app.get('/',          (req, res) => res.redirect('/dashboard'));
app.get('/login',     (req, res) => res.sendFile(path.join(__dirname,'public','login.html')));
app.get('/dashboard', requireAuth, (req, res) => res.sendFile(path.join(__dirname,'public','dashboard.html')));
app.get('/entry',     requireAuth, (req, res) => res.sendFile(path.join(__dirname,'public','entry.html')));

// ─────────────────────────────────────────────────────────
//  AUTH ROUTES
// ─────────────────────────────────────────────────────────
app.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Invalid username or password' });
  req.session.userId   = user.id;
  req.session.username = user.username;
  req.session.role     = user.role;
  res.json({ ok: true, username: user.username, role: user.role });
});

app.post('/auth/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });

app.get('/auth/me', (req, res) => {
  if (!req.session?.userId) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, username: req.session.username, role: req.session.role });
});

// ─────────────────────────────────────────────────────────
//  DATA API — READ (now requires login — dashboard is protected)
// ─────────────────────────────────────────────────────────
app.get('/api/data', requireAuthAPI, (req, res) => {
  const allCheques = db.prepare('SELECT * FROM pdc_cheques ORDER BY date,id').all();
  const demands    = db.prepare('SELECT * FROM vendor_demands ORDER BY id').all();
  const cashVendors= db.prepare('SELECT * FROM cash_vendors ORDER BY id').all();
  const todayNote  = db.prepare("SELECT * FROM daily_notes WHERE date=date('now','localtime')").get();

  // Expenses: split pending vs paid
  const allExpenses     = db.prepare('SELECT * FROM upcoming_expenses ORDER BY due_date,id').all();
  const pendingExpenses = allExpenses.filter(e => e.status !== 'Paid');
  const paidExpenses    = allExpenses.filter(e => e.status === 'Paid');

  // Refunds: split pending vs paid
  const allRefunds     = db.prepare('SELECT * FROM refunds ORDER BY created_at DESC').all();
  const pendingRefunds = allRefunds.filter(r => r.status !== 'Paid');
  const paidRefunds    = allRefunds.filter(r => r.status === 'Paid');

  // PDC: pending only for liabilities; paid as archived record
  const pendingCheques = allCheques.filter(c => c.status !== 'Paid');
  const paidCheques    = allCheques.filter(c => c.status === 'Paid')
    .sort((a,b) => (b.paid_at||'').localeCompare(a.paid_at||''));

  const grouped = {};
  pendingCheques.forEach(c => {
    if (!grouped[c.date]) grouped[c.date] = [];
    grouped[c.date].push(c);
  });

  const months = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  const pdcSchedule = Object.entries(grouped).sort().map(([date, cqs]) => {
    const [y,m,d] = date.split('-').map(Number);
    return { isoDate: date, label: `${d} ${months[m-1]} ${y}`,
             total: cqs.reduce((s,c)=>s+c.amount,0), cheques: cqs };
  });

  res.json({
    pdcSchedule, paidCheques,
    demands, cashVendors,
    pendingExpenses, paidExpenses,
    pendingRefunds, paidRefunds,
    notes: todayNote?.notes || '',
    lastUpdated: new Date().toISOString()
  });
});

// ─────────────────────────────────────────────────────────
//  DATA API — WRITE
// ─────────────────────────────────────────────────────────

// ── A: PDC Cheques ────────────────────────────────────────
app.get('/api/pdc', requireAuthAPI, (req,res) =>
  res.json(db.prepare('SELECT * FROM pdc_cheques ORDER BY date,id').all()));

app.post('/api/pdc', requireAuthAPI, (req,res) => {
  const { date, vendor, cheque_no, amount } = req.body;
  if (!date||!vendor||!amount) return res.status(400).json({error:'Missing fields'});
  const r = db.prepare('INSERT INTO pdc_cheques (date,vendor,cheque_no,amount,created_by) VALUES (?,?,?,?,?)')
    .run(date, vendor.toUpperCase().trim(), cheque_no||'', parseFloat(amount), req.session.username);
  res.json({ ok:true, id:r.lastInsertRowid });
});

app.delete('/api/pdc/:id', requireAuthAPI, (req,res) => {
  db.prepare('DELETE FROM pdc_cheques WHERE id=?').run(req.params.id);
  res.json({ ok:true });
});

app.put('/api/pdc/:id/paid', requireAuthAPI, (req, res) => {
  const cheque = db.prepare('SELECT * FROM pdc_cheques WHERE id=?').get(req.params.id);
  if (!cheque) return res.status(404).json({ error: 'Cheque not found' });
  if (cheque.status === 'Paid') return res.status(400).json({ error: 'Already marked as Paid' });
  const today = new Date(); today.setHours(0,0,0,0);
  const [y,m,d] = cheque.date.split('-').map(Number);
  const chequeDate = new Date(y,m-1,d); chequeDate.setHours(0,0,0,0);
  if (chequeDate > today) {
    const mn=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return res.status(403).json({ error:`🔒 Date lock: Cannot mark Paid before ${d} ${mn[m-1]} ${y}. Unlocks on cheque date.` });
  }
  db.prepare("UPDATE pdc_cheques SET status='Paid',paid_at=datetime('now','localtime'),created_by=? WHERE id=?")
    .run(req.session.username, req.params.id);
  res.json({ ok:true });
});

// ── B: Vendor Demands ─────────────────────────────────────
app.get('/api/demands', requireAuthAPI, (req,res) =>
  res.json(db.prepare('SELECT * FROM vendor_demands ORDER BY id').all()));

app.post('/api/demands', requireAuthAPI, (req,res) => {
  const { vendor, amount, priority } = req.body;
  if (!vendor||!amount) return res.status(400).json({error:'Missing fields'});
  const r = db.prepare('INSERT INTO vendor_demands (vendor,amount,priority,updated_by) VALUES (?,?,?,?)')
    .run(vendor.toUpperCase().trim(), parseFloat(amount), priority||'Medium', req.session.username);
  res.json({ ok:true, id:r.lastInsertRowid });
});

app.put('/api/demands/:id', requireAuthAPI, (req,res) => {
  const { status, amount, priority } = req.body;
  db.prepare('UPDATE vendor_demands SET status=?,amount=COALESCE(?,amount),priority=COALESCE(?,priority),updated_by=?,updated_at=datetime("now") WHERE id=?')
    .run(status, amount?parseFloat(amount):null, priority||null, req.session.username, req.params.id);
  res.json({ ok:true });
});

app.delete('/api/demands/:id', requireAuthAPI, (req,res) => {
  db.prepare('DELETE FROM vendor_demands WHERE id=?').run(req.params.id);
  res.json({ ok:true });
});

// ── C: Cash Vendors ───────────────────────────────────────
app.get('/api/cash-vendors', requireAuthAPI, (req,res) =>
  res.json(db.prepare('SELECT * FROM cash_vendors ORDER BY id').all()));

app.post('/api/cash-vendors', requireAuthAPI, (req,res) => {
  const { vendor, date, amount } = req.body;
  if (!vendor||!amount) return res.status(400).json({error:'Missing fields'});
  const r = db.prepare('INSERT INTO cash_vendors (vendor,date,amount,created_by) VALUES (?,?,?,?)')
    .run(vendor.toUpperCase().trim(), date||'', parseFloat(amount), req.session.username);
  res.json({ ok:true, id:r.lastInsertRowid });
});

app.delete('/api/cash-vendors/:id', requireAuthAPI, (req,res) => {
  db.prepare('DELETE FROM cash_vendors WHERE id=?').run(req.params.id);
  res.json({ ok:true });
});

// ── D: Upcoming / Required Expenses ──────────────────────
app.get('/api/expenses', requireAuthAPI, (req,res) =>
  res.json(db.prepare('SELECT * FROM upcoming_expenses ORDER BY due_date,id').all()));

app.post('/api/expenses', requireAuthAPI, (req,res) => {
  const { description, amount, category, due_date } = req.body;
  if (!description||!amount) return res.status(400).json({error:'Missing fields'});
  const r = db.prepare('INSERT INTO upcoming_expenses (description,amount,category,due_date,created_by) VALUES (?,?,?,?,?)')
    .run(description.trim(), parseFloat(amount), category||'General', due_date||'', req.session.username);
  res.json({ ok:true, id:r.lastInsertRowid });
});

app.put('/api/expenses/:id/paid', requireAuthAPI, (req,res) => {
  const exp = db.prepare('SELECT * FROM upcoming_expenses WHERE id=?').get(req.params.id);
  if (!exp) return res.status(404).json({ error:'Not found' });
  db.prepare("UPDATE upcoming_expenses SET status='Paid',paid_at=datetime('now','localtime'),created_by=? WHERE id=?")
    .run(req.session.username, req.params.id);
  res.json({ ok:true });
});

app.put('/api/expenses/:id/pending', requireAuthAPI, (req,res) => {
  db.prepare("UPDATE upcoming_expenses SET status='Pending',paid_at=NULL WHERE id=?").run(req.params.id);
  res.json({ ok:true });
});

app.delete('/api/expenses/:id', requireAuthAPI, (req,res) => {
  db.prepare('DELETE FROM upcoming_expenses WHERE id=?').run(req.params.id);
  res.json({ ok:true });
});

// ── E: Refunds ────────────────────────────────────────────
// Report route MUST come before /:id routes
app.get('/api/refunds/report', requireAuthAPI, (req,res) => {
  const refunds = db.prepare('SELECT * FROM refunds ORDER BY created_at DESC').all();
  const rows = [['ID','Order No','Customer Phone','Amount (PKR)','Status','Notes','Attachment','Added By','Date Added','Paid At']];
  refunds.forEach(r => rows.push([
    r.id, r.order_number||'', r.customer_phone||'', r.amount, r.status,
    (r.notes||'').replace(/,/g,' '), r.attachment_name||'',
    r.created_by||'', r.created_at||'', r.paid_at||''
  ]));
  const csv = rows.map(r => r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition',`attachment; filename="refunds-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send(csv);
});

app.get('/api/refunds', requireAuthAPI, (req,res) =>
  res.json(db.prepare('SELECT * FROM refunds ORDER BY created_at DESC').all()));

app.post('/api/refunds', requireAuthAPI, upload.single('attachment'), (req,res) => {
  const { order_number, customer_phone, amount, notes } = req.body;
  if (!amount) return res.status(400).json({error:'Amount is required'});
  const r = db.prepare('INSERT INTO refunds (order_number,customer_phone,amount,notes,attachment_path,attachment_name,created_by) VALUES (?,?,?,?,?,?,?)')
    .run(order_number||'', customer_phone||'', parseFloat(amount), notes||'',
         req.file?.filename||null, req.file?.originalname||null, req.session.username);
  res.json({ ok:true, id:r.lastInsertRowid });
});

app.put('/api/refunds/:id/paid', requireAuthAPI, (req,res) => {
  const ref = db.prepare('SELECT * FROM refunds WHERE id=?').get(req.params.id);
  if (!ref) return res.status(404).json({ error:'Not found' });
  db.prepare("UPDATE refunds SET status='Paid',paid_at=datetime('now','localtime'),created_by=? WHERE id=?")
    .run(req.session.username, req.params.id);
  res.json({ ok:true });
});

app.put('/api/refunds/:id/pending', requireAuthAPI, (req,res) => {
  db.prepare("UPDATE refunds SET status='Pending',paid_at=NULL WHERE id=?").run(req.params.id);
  res.json({ ok:true });
});

app.delete('/api/refunds/:id', requireAuthAPI, (req,res) => {
  const ref = db.prepare('SELECT * FROM refunds WHERE id=?').get(req.params.id);
  if (ref?.attachment_path) {
    try { fs.unlinkSync(path.join(UPLOADS_DIR, ref.attachment_path)); } catch(e) {}
  }
  db.prepare('DELETE FROM refunds WHERE id=?').run(req.params.id);
  res.json({ ok:true });
});

app.get('/api/refunds/:id/attachment', requireAuthAPI, (req,res) => {
  const ref = db.prepare('SELECT * FROM refunds WHERE id=?').get(req.params.id);
  if (!ref?.attachment_path) return res.status(404).json({ error:'No attachment' });
  const fp = path.join(UPLOADS_DIR, ref.attachment_path);
  if (!fs.existsSync(fp)) return res.status(404).json({ error:'File not found on server' });
  res.download(fp, ref.attachment_name || ref.attachment_path);
});

// ── Notes ─────────────────────────────────────────────────
app.post('/api/notes', requireAuthAPI, (req,res) => {
  const { notes } = req.body;
  const today = new Date().toISOString().slice(0,10);
  db.prepare('INSERT INTO daily_notes (date,notes,updated_by) VALUES (?,?,?) ON CONFLICT(date) DO UPDATE SET notes=excluded.notes,updated_by=excluded.updated_by,updated_at=datetime("now")')
    .run(today, notes||'', req.session.username);
  res.json({ ok:true });
});

// ── Users (admin only) ────────────────────────────────────
app.get('/api/users', requireAuthAPI, requireAdmin, (req,res) =>
  res.json(db.prepare('SELECT id,username,role,created_at FROM users').all()));

app.post('/api/users', requireAuthAPI, requireAdmin, (req,res) => {
  const { username, password, role } = req.body;
  if (!username||!password) return res.status(400).json({error:'Missing fields'});
  try {
    db.prepare('INSERT INTO users (username,password_hash,role) VALUES (?,?,?)')
      .run(username.trim(), bcrypt.hashSync(password,10), role||'staff');
    res.json({ ok:true });
  } catch(e) { res.status(400).json({ error:'Username already exists' }); }
});

app.delete('/api/users/:id', requireAuthAPI, requireAdmin, (req,res) => {
  if (parseInt(req.params.id)===req.session.userId) return res.status(400).json({error:"Can't delete yourself"});
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.json({ ok:true });
});

app.put('/api/users/:id/password', requireAuthAPI, (req,res) => {
  if (req.session.role!=='admin' && req.session.userId!==parseInt(req.params.id))
    return res.status(403).json({error:'Not allowed'});
  const { password } = req.body;
  if (!password||password.length<6) return res.status(400).json({error:'Password too short (min 6)'});
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(password,10),req.params.id);
  res.json({ ok:true });
});

// ─────────────────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════╗
║    VENDOR PAYMENT SYSTEM — RUNNING            ║
╚═══════════════════════════════════════════════╝

  Dashboard:    http://localhost:${PORT}/dashboard
  Entry Panel:  http://localhost:${PORT}/entry
  Login:        http://localhost:${PORT}/login

  Default logins:
    admin / admin123  (can manage users)
    team  / team123   (data entry only)

  ⚠️  Change passwords after first login!
  🔒 Dashboard now requires login.
  📁 Uploads stored at: ${UPLOADS_DIR}
`);
});
