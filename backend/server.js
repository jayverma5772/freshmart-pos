const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'freshmart-dev-secret-change-in-prod';
const isPg = Boolean(process.env.DATABASE_URL);

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '../app/www')));

// ---------- DUAL DB ADAPTER (PostgreSQL for Cloud / SQLite for Local) ----------
let pgPool = null;
let sqliteDb = null;

if (isPg) {
  const { Pool } = require('pg');
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
} else {
  const sqlite3 = require('sqlite3').verbose();
  sqliteDb = new sqlite3.Database(path.join(__dirname, 'freshmart.db'));
}

function toPgSql(sql) {
  let idx = 0;
  return sql.replace(/\?/g, () => `$${++idx}`);
}

async function dbAll(sql, params = []) {
  if (isPg) {
    const res = await pgPool.query(toPgSql(sql), params);
    return res.rows;
  }
  return new Promise((resolve, reject) => {
    sqliteDb.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

async function dbGet(sql, params = []) {
  const rows = await dbAll(sql, params);
  return rows[0] || null;
}

async function dbRun(sql, params = []) {
  if (isPg) {
    await pgPool.query(toPgSql(sql), params);
    return { ok: true };
  }
  return new Promise((resolve, reject) => {
    sqliteDb.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

async function dbInsert(sql, params = []) {
  if (isPg) {
    const res = await pgPool.query(`${toPgSql(sql)} RETURNING id`, params);
    return res.rows[0].id;
  }
  return new Promise((resolve, reject) => {
    sqliteDb.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this.lastID);
    });
  });
}

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// ---------- AUTH HELPERS (No extra npm packages needed) ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, stored) {
  const [salt, key] = String(stored || '').split(':');
  if (!salt || !key) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const keyBuf = Buffer.from(key, 'hex');
  return crypto.timingSafeEqual(derived, keyBuf);
}

function signToken(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifyToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(data).digest('base64url');
  if (sig !== expected) return null;
  try {
    return JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const payload = verifyToken(token);
  if (!payload || !payload.storeId) return res.status(401).json({ error: 'Session expired. Please login again.' });
  req.storeId = payload.storeId;
  next();
}

// ---------- INIT DATABASE ----------
async function initDB() {
  const pk = isPg ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';

  await dbRun(`
    CREATE TABLE IF NOT EXISTS stores (
      id ${pk},
      shop_name TEXT NOT NULL,
      owner_name TEXT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      gstin TEXT DEFAULT '',
      address TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      upi_id TEXT DEFAULT '',
      currency TEXT DEFAULT '₹',
      tax_inclusive INTEGER DEFAULT 1,
      created_at TEXT
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS products (
      id ${pk},
      store_id INTEGER NOT NULL,
      sku TEXT,
      name TEXT NOT NULL,
      category TEXT,
      hsn TEXT,
      gst_rate REAL DEFAULT 0,
      cost REAL NOT NULL,
      price REAL NOT NULL,
      stock REAL NOT NULL,
      unit TEXT DEFAULT 'pcs',
      min_stock REAL DEFAULT 5,
      expiry TEXT
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS customers (
      id ${pk},
      store_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      gstin TEXT,
      balance REAL DEFAULT 0,
      last_updated TEXT
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS sales (
      id ${pk},
      store_id INTEGER NOT NULL,
      invoice_no TEXT NOT NULL,
      date TEXT,
      customer_id INTEGER,
      customer_name TEXT,
      customer_gstin TEXT,
      pay_mode TEXT,
      taxable_total REAL,
      cgst_total REAL,
      sgst_total REAL,
      discount REAL,
      total REAL,
      profit REAL,
      items_json TEXT,
      UNIQUE(store_id, invoice_no)
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS khata_payments (
      id ${pk},
      store_id INTEGER NOT NULL,
      customer_id INTEGER,
      amount REAL,
      date TEXT
    )
  `);
}

// ---------- AUTH ROUTES ----------
app.get('/api/health', (req, res) => res.json({ ok: true, db: isPg ? 'PostgreSQL' : 'SQLite' }));

app.post('/api/auth/register', async (req, res) => {
  try {
    const { shop_name, owner_name, email, password, phone, gstin, address, upi_id, seed_demo } = req.body;
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!shop_name || !cleanEmail || !password || password.length < 4) {
      return res.status(400).json({ error: 'Shop name, valid email, and password (min 4 chars) are required.' });
    }

    const existing = await dbGet('SELECT id FROM stores WHERE email = ?', [cleanEmail]);
    if (existing) return res.status(400).json({ error: 'A store is already registered with this email.' });

    const storeId = await dbInsert(
      `INSERT INTO stores (shop_name, owner_name, email, password_hash, gstin, address, phone, upi_id, currency, tax_inclusive, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '₹', 1, ?)`,
      [shop_name.trim(), owner_name || '', cleanEmail, hashPassword(password), gstin || '', address || '', phone || '', upi_id || '', new Date().toISOString()]
    );

    if (seed_demo) {
      const future = (d) => new Date(Date.now() + d * 86400000).toISOString().split('T')[0];
      const samples = [
        [storeId, '1001', 'Basmati Rice', 'Grains & Pulses', '1006', 5, 85, 110, 40, 'kg', 10, ''],
        [storeId, '1002', 'Toor Dal', 'Grains & Pulses', '0713', 0, 120, 150, 15, 'kg', 5, ''],
        [storeId, '1003', 'Full Cream Milk (1L)', 'Dairy & Bakery', '0401', 0, 58, 66, 20, 'pack', 8, future(2)],
        [storeId, '1004', 'Sunflower Oil (1L)', 'Spices & Oil', '1512', 5, 118, 145, 25, 'L', 5, future(180)],
        [storeId, '1005', 'Dishwash Gel', 'Household', '3402', 18, 80, 105, 12, 'pcs', 4, future(365)]
      ];
      for (const p of samples) {
        await dbRun(
          `INSERT INTO products (store_id, sku, name, category, hsn, gst_rate, cost, price, stock, unit, min_stock, expiry)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          p
        );
      }
    }

    const token = signToken({ storeId, email: cleanEmail });
    res.json({ token, store: { id: storeId, shop_name: shop_name.trim(), email: cleanEmail } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const cleanEmail = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const store = await dbGet('SELECT * FROM stores WHERE email = ?', [cleanEmail]);
    if (!store || !verifyPassword(password, store.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    const token = signToken({ storeId: store.id, email: store.email });
    res.json({ token, store: { id: store.id, shop_name: store.shop_name, email: store.email } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- PROTECTED STORE ROUTES (Strictly isolated by req.storeId) ----------
app.get('/api/bootstrap', requireAuth, async (req, res) => {
  try {
    const settings = await dbGet(
      'SELECT id, shop_name, owner_name, email, gstin, address, phone, upi_id, currency, tax_inclusive FROM stores WHERE id = ?',
      [req.storeId]
    );
    const products = await dbAll('SELECT * FROM products WHERE store_id = ? ORDER BY id DESC', [req.storeId]);
    const customers = await dbAll('SELECT * FROM customers WHERE store_id = ? ORDER BY id DESC', [req.storeId]);
    const salesRows = await dbAll('SELECT * FROM sales WHERE store_id = ? ORDER BY id DESC LIMIT 200', [req.storeId]);
    const sales = salesRows.map((s) => ({ ...s, items: JSON.parse(s.items_json || '[]') }));
    res.json({ settings, products, customers, sales });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/settings', requireAuth, async (req, res) => {
  try {
    const { shop_name, gstin, address, phone, upi_id, currency, tax_inclusive } = req.body;
    await dbRun(
      `UPDATE stores SET shop_name=?, gstin=?, address=?, phone=?, upi_id=?, currency=?, tax_inclusive=? WHERE id=?`,
      [shop_name, gstin, address, phone, upi_id, currency || '₹', tax_inclusive ? 1 : 0, req.storeId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/products', requireAuth, async (req, res) => {
  try {
    const p = req.body;
    const id = await dbInsert(
      `INSERT INTO products (store_id, sku, name, category, hsn, gst_rate, cost, price, stock, unit, min_stock, expiry)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.storeId, p.sku || '', p.name, p.category, p.hsn || '', p.gst_rate || 0, p.cost, p.price, p.stock, p.unit, p.min_stock || 5, p.expiry || '']
    );
    res.json({ id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/products/:id', requireAuth, async (req, res) => {
  try {
    const p = req.body;
    await dbRun(
      `UPDATE products SET sku=?, name=?, category=?, hsn=?, gst_rate=?, cost=?, price=?, stock=?, unit=?, min_stock=?, expiry=? WHERE id=? AND store_id=?`,
      [p.sku || '', p.name, p.category, p.hsn || '', p.gst_rate || 0, p.cost, p.price, p.stock, p.unit, p.min_stock || 5, p.expiry || '', req.params.id, req.storeId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/products/:id/restock', requireAuth, async (req, res) => {
  try {
    const qty = Number(req.body.qty);
    if (!qty || qty <= 0) return res.status(400).json({ error: 'Invalid quantity' });
    const prod = await dbGet('SELECT stock FROM products WHERE id = ? AND store_id = ?', [req.params.id, req.storeId]);
    if (!prod) return res.status(404).json({ error: 'Product not found' });
    await dbRun('UPDATE products SET stock = ? WHERE id = ? AND store_id = ?', [round2(Number(prod.stock) + qty), req.params.id, req.storeId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/products/:id', requireAuth, async (req, res) => {
  try {
    await dbRun('DELETE FROM products WHERE id = ? AND store_id = ?', [req.params.id, req.storeId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/customers', requireAuth, async (req, res) => {
  try {
    const { name, phone, gstin, balance } = req.body;
    const id = await dbInsert(
      `INSERT INTO customers (store_id, name, phone, gstin, balance, last_updated) VALUES (?, ?, ?, ?, ?, ?)`,
      [req.storeId, name, phone, gstin || '', Number(balance) || 0, new Date().toISOString()]
    );
    res.json({ id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/customers/:id/pay', requireAuth, async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid payment amount' });
    const cust = await dbGet('SELECT balance FROM customers WHERE id = ? AND store_id = ?', [req.params.id, req.storeId]);
    if (!cust) return res.status(404).json({ error: 'Customer not found' });

    const newBal = Math.max(0, round2(Number(cust.balance) - amount));
    const now = new Date().toISOString();
    await dbRun('UPDATE customers SET balance = ?, last_updated = ? WHERE id = ? AND store_id = ?', [newBal, now, req.params.id, req.storeId]);
    await dbRun('INSERT INTO khata_payments (store_id, customer_id, amount, date) VALUES (?, ?, ?, ?)', [req.storeId, req.params.id, amount, now]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sales', requireAuth, async (req, res) => {
  try {
    const { items, discount, pay_mode, customer_id, customer_name, customer_gstin } = req.body;
    if (!items || !items.length) return res.status(400).json({ error: 'Cart is empty' });

    const settings = await dbGet('SELECT tax_inclusive FROM stores WHERE id = ?', [req.storeId]);
    const taxInclusive = Boolean(settings.tax_inclusive);

    let taxableTotal = 0, cgstTotal = 0, sgstTotal = 0, grossTotal = 0, costTotal = 0;
    const enrichedItems = [];

    for (const item of items) {
      const prod = await dbGet('SELECT * FROM products WHERE id = ? AND store_id = ?', [item.id, req.storeId]);
      if (!prod) return res.status(400).json({ error: `Product ID ${item.id} not found` });
      if (Number(prod.stock) < item.qty) return res.status(400).json({ error: `Insufficient stock for ${prod.name}` });

      const rate = Number(prod.gst_rate || 0);
      const lineBase = Number(prod.price) * item.qty;
      let lineTaxable, lineTax, lineTotal;

      if (taxInclusive) {
        lineTotal = lineBase;
        lineTaxable = rate > 0 ? lineBase / (1 + rate / 100) : lineBase;
        lineTax = lineTotal - lineTaxable;
      } else {
        lineTaxable = lineBase;
        lineTax = lineBase * (rate / 100);
        lineTotal = lineTaxable + lineTax;
      }

      const cgst = lineTax / 2;
      const sgst = lineTax / 2;
      taxableTotal += lineTaxable;
      cgstTotal += cgst;
      sgstTotal += sgst;
      grossTotal += lineTotal;
      costTotal += Number(prod.cost) * item.qty;

      enrichedItems.push({
        id: prod.id, name: prod.name, hsn: prod.hsn || '', unit: prod.unit,
        qty: item.qty, price: Number(prod.price), gst_rate: rate,
        oldStock: Number(prod.stock),
        taxable: round2(lineTaxable), cgst: round2(cgst), sgst: round2(sgst), total: round2(lineTotal)
      });
    }

    const disc = Math.max(0, Number(discount) || 0);
    const finalTotal = Math.max(0, round2(grossTotal - disc));
    const profit = round2(taxableTotal - costTotal - disc);

    for (const it of enrichedItems) {
      const newStock = Math.max(0, round2(it.oldStock - it.qty));
      delete it.oldStock;
      await dbRun('UPDATE products SET stock = ? WHERE id = ? AND store_id = ?', [newStock, it.id, req.storeId]);
    }

    const now = new Date().toISOString();
    if (pay_mode === 'Credit' && customer_id) {
      const cust = await dbGet('SELECT balance FROM customers WHERE id = ? AND store_id = ?', [customer_id, req.storeId]);
      if (cust) {
        await dbRun('UPDATE customers SET balance = ?, last_updated = ? WHERE id = ? AND store_id = ?', [
          round2(Number(cust.balance) + finalTotal), now, customer_id, req.storeId
        ]);
      }
    }

    const countRow = await dbGet('SELECT COUNT(*) as c FROM sales WHERE store_id = ?', [req.storeId]);
    const invoiceNo = `INV-${1001 + Number(countRow.c)}`;

    const saleObj = {
      invoice_no: invoiceNo, date: now, customer_id: customer_id || null,
      customer_name: customer_name || 'Walk-in Customer', customer_gstin: customer_gstin || '',
      pay_mode, taxable_total: round2(taxableTotal), cgst_total: round2(cgstTotal),
      sgst_total: round2(sgstTotal), discount: disc, total: finalTotal, profit, items: enrichedItems
    };

    await dbRun(
      `INSERT INTO sales (store_id, invoice_no, date, customer_id, customer_name, customer_gstin, pay_mode, taxable_total, cgst_total, sgst_total, discount, total, profit, items_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.storeId, saleObj.invoice_no, saleObj.date, saleObj.customer_id, saleObj.customer_name,
        saleObj.customer_gstin, saleObj.pay_mode, saleObj.taxable_total, saleObj.cgst_total,
        saleObj.sgst_total, saleObj.discount, saleObj.total, saleObj.profit, JSON.stringify(enrichedItems)
      ]
    );

    res.json(saleObj);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`FreshMart Multi-Store Server (${isPg ? 'PostgreSQL' : 'SQLite'}) running on port ${PORT}`);
  });
});
