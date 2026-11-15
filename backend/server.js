const express = require('express');
const cors = require('cors');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '../app/www')));

const db = new sqlite3.Database(path.join(__dirname, 'freshmart.db'));

const dbRun = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });

const dbGet = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });

const dbAll = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });

async function initDB() {
  await dbRun(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      shop_name TEXT,
      gstin TEXT,
      address TEXT,
      phone TEXT,
      upi_id TEXT,
      currency TEXT,
      tax_inclusive INTEGER DEFAULT 1
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      gstin TEXT,
      balance REAL DEFAULT 0,
      last_updated TEXT
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_no TEXT UNIQUE,
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
      items_json TEXT
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS khata_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER,
      amount REAL,
      date TEXT
    )
  `);

  const existingSettings = await dbGet('SELECT * FROM settings WHERE id = 1');
  if (!existingSettings) {
    await dbRun(
      `INSERT INTO settings (id, shop_name, gstin, address, phone, upi_id, currency, tax_inclusive)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
      ['FreshMart Superstore', '27ABCDE1234F1Z5', 'Main Market Road, Near Bus Stand', '9876543210', 'freshmart@upi', '₹', 1]
    );
  }

  const prodCount = await dbGet('SELECT COUNT(*) as c FROM products');
  if (prodCount.c === 0) {
    const future = (d) => new Date(Date.now() + d * 86400000).toISOString().split('T')[0];
    const seedProducts = [
      ['1001', 'Basmati Rice', 'Grains & Pulses', '1006', 5, 85, 110, 45, 'kg', 10, ''],
      ['1002', 'Toor Dal', 'Grains & Pulses', '0713', 0, 120, 150, 8, 'kg', 10, ''],
      ['1003', 'Full Cream Milk (1L)', 'Dairy & Bakery', '0401', 0, 58, 66, 24, 'pack', 10, future(2)],
      ['1004', 'Amul Butter (100g)', 'Dairy & Bakery', '0405', 12, 48, 56, 15, 'pcs', 5, future(25)],
      ['1005', 'Sunflower Oil (1L)', 'Spices & Oil', '1512', 5, 118, 145, 30, 'L', 8, future(180)],
      ['1006', 'Masala Chips', 'Snacks & Drinks', '2106', 12, 15, 20, 50, 'pcs', 12, future(90)],
      ['1007', 'Dishwash Gel (500ml)', 'Household', '3402', 18, 80, 105, 14, 'pcs', 5, future(365)]
    ];
    for (const p of seedProducts) {
      await dbRun(
        `INSERT INTO products (sku, name, category, hsn, gst_rate, cost, price, stock, unit, min_stock, expiry)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        p
      );
    }
  }

  const custCount = await dbGet('SELECT COUNT(*) as c FROM customers');
  if (custCount.c === 0) {
    await dbRun(
      `INSERT INTO customers (name, phone, gstin, balance, last_updated) VALUES (?, ?, ?, ?, ?)`,
      ['Ramesh Verma', '9876501234', '', 450, new Date().toISOString()]
    );
    await dbRun(
      `INSERT INTO customers (name, phone, gstin, balance, last_updated) VALUES (?, ?, ?, ?, ?)`,
      ['Sunita Kirana Traders', '9811223344', '27XYZAB5678G1Z2', 0, new Date().toISOString()]
    );
  }
}

app.get('/api/bootstrap', async (req, res) => {
  try {
    const settings = await dbGet('SELECT * FROM settings WHERE id = 1');
    const products = await dbAll('SELECT * FROM products ORDER BY id DESC');
    const customers = await dbAll('SELECT * FROM customers ORDER BY id DESC');
    const salesRows = await dbAll('SELECT * FROM sales ORDER BY id DESC LIMIT 200');
    const sales = salesRows.map((s) => ({ ...s, items: JSON.parse(s.items_json || '[]') }));
    res.json({ settings, products, customers, sales });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/settings', async (req, res) => {
  try {
    const { shop_name, gstin, address, phone, upi_id, currency, tax_inclusive } = req.body;
    await dbRun(
      `UPDATE settings SET shop_name=?, gstin=?, address=?, phone=?, upi_id=?, currency=?, tax_inclusive=? WHERE id=1`,
      [shop_name, gstin, address, phone, upi_id, currency, tax_inclusive ? 1 : 0]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/products', async (req, res) => {
  try {
    const p = req.body;
    const r = await dbRun(
      `INSERT INTO products (sku, name, category, hsn, gst_rate, cost, price, stock, unit, min_stock, expiry)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [p.sku, p.name, p.category, p.hsn || '', p.gst_rate || 0, p.cost, p.price, p.stock, p.unit, p.min_stock || 5, p.expiry || '']
    );
    res.json({ id: r.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/products/:id', async (req, res) => {
  try {
    const p = req.body;
    await dbRun(
      `UPDATE products SET sku=?, name=?, category=?, hsn=?, gst_rate=?, cost=?, price=?, stock=?, unit=?, min_stock=?, expiry=? WHERE id=?`,
      [p.sku, p.name, p.category, p.hsn || '', p.gst_rate || 0, p.cost, p.price, p.stock, p.unit, p.min_stock || 5, p.expiry || '', req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/products/:id/restock', async (req, res) => {
  try {
    const qty = Number(req.body.qty);
    if (!qty || qty <= 0) return res.status(400).json({ error: 'Invalid quantity' });
    await dbRun('UPDATE products SET stock = ROUND(stock + ?, 2) WHERE id = ?', [qty, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/products/:id', async (req, res) => {
  try {
    await dbRun('DELETE FROM products WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/customers', async (req, res) => {
  try {
    const { name, phone, gstin, balance } = req.body;
    const r = await dbRun(
      `INSERT INTO customers (name, phone, gstin, balance, last_updated) VALUES (?, ?, ?, ?, ?)`,
      [name, phone, gstin || '', Number(balance) || 0, new Date().toISOString()]
    );
    res.json({ id: r.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/customers/:id/pay', async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid payment amount' });
    const now = new Date().toISOString();
    await dbRun(
      `UPDATE customers SET balance = MAX(0, ROUND(balance - ?, 2)), last_updated = ? WHERE id = ?`,
      [amount, now, req.params.id]
    );
    await dbRun(`INSERT INTO khata_payments (customer_id, amount, date) VALUES (?, ?, ?)`, [req.params.id, amount, now]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sales', async (req, res) => {
  try {
    const { items, discount, pay_mode, customer_id, customer_name, customer_gstin } = req.body;
    if (!items || !items.length) return res.status(400).json({ error: 'Cart is empty' });

    const settings = await dbGet('SELECT * FROM settings WHERE id = 1');
    const taxInclusive = Boolean(settings.tax_inclusive);

    let taxableTotal = 0, cgstTotal = 0, sgstTotal = 0, grossTotal = 0, costTotal = 0;
    const enrichedItems = [];

    for (const item of items) {
      const prod = await dbGet('SELECT * FROM products WHERE id = ?', [item.id]);
      if (!prod) return res.status(400).json({ error: `Product ID ${item.id} not found` });
      if (prod.stock < item.qty) return res.status(400).json({ error: `Insufficient stock for ${prod.name}` });

      const rate = Number(prod.gst_rate || 0);
      const lineBase = prod.price * item.qty;
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
      costTotal += prod.cost * item.qty;

      enrichedItems.push({
        id: prod.id, name: prod.name, hsn: prod.hsn || '', unit: prod.unit,
        qty: item.qty, price: prod.price, gst_rate: rate,
        taxable: Math.round(lineTaxable * 100) / 100,
        cgst: Math.round(cgst * 100) / 100,
        sgst: Math.round(sgst * 100) / 100,
        total: Math.round(lineTotal * 100) / 100
      });
    }

    const disc = Math.max(0, Number(discount) || 0);
    const finalTotal = Math.max(0, Math.round((grossTotal - disc) * 100) / 100);
    const profit = Math.round((taxableTotal - costTotal - disc) * 100) / 100;

    for (const it of enrichedItems) {
      await dbRun('UPDATE products SET stock = MAX(0, ROUND(stock - ?, 2)) WHERE id = ?', [it.qty, it.id]);
    }

    const now = new Date().toISOString();
    if (pay_mode === 'Credit' && customer_id) {
      await dbRun('UPDATE customers SET balance = ROUND(balance + ?, 2), last_updated = ? WHERE id = ?', [
        finalTotal, now, customer_id
      ]);
    }

    const countRow = await dbGet('SELECT COUNT(*) as c FROM sales');
    const invoiceNo = `INV-${1001 + countRow.c}`;

    const saleObj = {
      invoice_no: invoiceNo, date: now, customer_id: customer_id || null,
      customer_name: customer_name || 'Walk-in Customer', customer_gstin: customer_gstin || '',
      pay_mode, taxable_total: Math.round(taxableTotal * 100) / 100,
      cgst_total: Math.round(cgstTotal * 100) / 100, sgst_total: Math.round(sgstTotal * 100) / 100,
      discount: disc, total: finalTotal, profit, items: enrichedItems
    };

    await dbRun(
      `INSERT INTO sales (invoice_no, date, customer_id, customer_name, customer_gstin, pay_mode, taxable_total, cgst_total, sgst_total, discount, total, profit, items_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        saleObj.invoice_no, saleObj.date, saleObj.customer_id, saleObj.customer_name,
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
    console.log(`FreshMart Backend running on http://0.0.0.0:${PORT}`);
  });
});
