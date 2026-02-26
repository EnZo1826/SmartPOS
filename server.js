/**
 * EnZo POS — Custom REST Sync Backend
 * =====================================
 * Stack: Node.js + Express + better-sqlite3
 * 
 * Install:
 *   npm install express better-sqlite3 cors helmet dotenv uuid
 * 
 * Run:
 *   node server.js
 * 
 * Docker:
 *   docker build -t enzo-pos-backend .
 *   docker run -p 3000:3000 -v $(pwd)/data:/app/data enzo-pos-backend
 */

require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const helmet = require('helmet');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.API_TOKEN || 'enzo-pos-secret-token-change-me';
const DATA_DIR = process.env.DATA_DIR || './data';

// Ensure data directory
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── DATABASE ──────────────────────────────────────────────────────────
const db = new Database(path.join(DATA_DIR, 'pos.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    entity_uuid TEXT NOT NULL,
    server_id TEXT NOT NULL,
    device_id TEXT,
    operation TEXT,
    synced_at TEXT DEFAULT (datetime('now')),
    UNIQUE(entity_uuid)
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id TEXT NOT NULL UNIQUE,
    client_uuid TEXT NOT NULL UNIQUE,
    device_id TEXT,
    store_id TEXT,
    terminal_id TEXT,
    cashier_name TEXT,
    customer TEXT DEFAULT 'Walk-in',
    order_date TEXT,
    subtotal REAL DEFAULT 0,
    discount_amount REAL DEFAULT 0,
    tax_amount REAL DEFAULT 0,
    total REAL DEFAULT 0,
    status TEXT DEFAULT 'completed',
    receipt_number TEXT UNIQUE,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_server_id TEXT NOT NULL,
    item_uuid TEXT,
    item_name TEXT,
    qty REAL,
    unit_price REAL,
    line_discount REAL DEFAULT 0,
    line_total REAL,
    tax_rate REAL DEFAULT 0,
    FOREIGN KEY (order_server_id) REFERENCES orders(server_id)
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_server_id TEXT NOT NULL,
    method TEXT,
    amount REAL,
    tendered REAL,
    change_given REAL DEFAULT 0,
    FOREIGN KEY (order_server_id) REFERENCES orders(server_id)
  );

  CREATE TABLE IF NOT EXISTS refunds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id TEXT NOT NULL UNIQUE,
    client_uuid TEXT NOT NULL UNIQUE,
    order_client_uuid TEXT,
    order_server_id TEXT,
    reason TEXT,
    amount REAL,
    status TEXT DEFAULT 'processed',
    device_id TEXT,
    refund_date TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id TEXT NOT NULL UNIQUE,
    client_uuid TEXT NOT NULL UNIQUE,
    device_id TEXT,
    cashier_id TEXT,
    opened_at TEXT,
    closed_at TEXT,
    float_amount REAL DEFAULT 0,
    expected_cash REAL,
    counted_cash REAL,
    variance REAL,
    status TEXT DEFAULT 'open',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS cash_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id TEXT NOT NULL UNIQUE,
    client_uuid TEXT NOT NULL UNIQUE,
    shift_client_uuid TEXT,
    type TEXT,
    amount REAL,
    reason TEXT,
    device_id TEXT,
    event_date TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS catalog_products (
    uuid TEXT PRIMARY KEY,
    sku TEXT,
    barcode TEXT,
    name TEXT NOT NULL,
    category_uuid TEXT,
    price REAL DEFAULT 0,
    tax_rate REAL DEFAULT 0,
    emoji TEXT DEFAULT '📦',
    active INTEGER DEFAULT 1,
    stock REAL DEFAULT 0,
    track_stock INTEGER DEFAULT 1,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS catalog_categories (
    uuid TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS receipt_sequence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    year INTEGER,
    last_seq INTEGER DEFAULT 0
  );
`);

// ── MIDDLEWARE ─────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'] }));
app.use(express.json({ limit: '10mb' }));

// Request logger
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Auth middleware
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ') || auth.slice(7) !== API_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── RECEIPT NUMBER GENERATOR ───────────────────────────────────────────
function generateReceiptNumber() {
  const year = new Date().getFullYear();
  const stmt = db.prepare('SELECT last_seq FROM receipt_sequence WHERE year = ?');
  const row = stmt.get(year);

  let nextSeq;
  if (!row) {
    db.prepare('INSERT INTO receipt_sequence (year, last_seq) VALUES (?, 1)').run(year);
    nextSeq = 1;
  } else {
    nextSeq = row.last_seq + 1;
    db.prepare('UPDATE receipt_sequence SET last_seq = ? WHERE year = ?').run(nextSeq, year);
  }
  return `RCP-${year}-${String(nextSeq).padStart(5, '0')}`;
}

// ── ROUTES ─────────────────────────────────────────────────────────────

/**
 * GET /health
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '2.0',
    server_time: new Date().toISOString(),
    db: 'sqlite'
  });
});

/**
 * POST /sync/push
 * Receive batch of outbox items from POS terminal.
 * Fully idempotent — safe to retry.
 * 
 * Body: {
 *   batch: [{ outbox_id, entity_type, entity_uuid, operation, payload, device_id, terminal_id }],
 *   device_id: string,
 *   terminal_id: string
 * }
 */
app.post('/sync/push', requireAuth, (req, res) => {
  const { batch = [], device_id, terminal_id } = req.body;
  const processed = [];
  const failed = [];

  for (const item of batch) {
    const trx = db.transaction(() => {
      const { outbox_id, entity_type, entity_uuid, operation, payload } = item;
      const itemDeviceId = item.device_id || device_id || '';

      // Idempotency: check sync_log
      const existing = db.prepare('SELECT server_id FROM sync_log WHERE entity_uuid = ?').get(entity_uuid);

      if (existing && operation === 'create') {
        return { outbox_id, entity_uuid, server_id: existing.server_id, status: 'ok', duplicate: true };
      }

      const server_id = 'SRV-' + uuidv4().slice(0, 12).toUpperCase();

      switch (entity_type) {
        case 'order':
          processOrder(server_id, entity_uuid, payload, itemDeviceId, terminal_id);
          break;
        case 'refund':
          processRefund(server_id, entity_uuid, payload, itemDeviceId);
          break;
        case 'shift':
          processShift(server_id, entity_uuid, payload, itemDeviceId);
          break;
        case 'cash_event':
          processCashEvent(server_id, entity_uuid, payload, itemDeviceId);
          break;
        default:
          throw new Error(`Unknown entity_type: ${entity_type}`);
      }

      // Log to sync_log
      db.prepare(`
        INSERT OR REPLACE INTO sync_log (entity_type, entity_uuid, server_id, device_id, operation, synced_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
      `).run(entity_type, entity_uuid, server_id, itemDeviceId, operation);

      return { outbox_id, entity_uuid, server_id, status: 'ok' };
    });

    try {
      processed.push(trx());
    } catch (e) {
      failed.push({ outbox_id: item.outbox_id, entity_uuid: item.entity_uuid, error: e.message });
      console.error(`Push error [${item.entity_type}/${item.entity_uuid}]:`, e.message);
    }
  }

  res.json({ processed, failed });
});

function processOrder(server_id, client_uuid, payload, device_id, terminal_id) {
  const { order = {}, items = [], payments = [] } = payload;
  const receipt = generateReceiptNumber();

  db.prepare(`
    INSERT OR REPLACE INTO orders
    (server_id, client_uuid, device_id, store_id, terminal_id, cashier_name, customer,
     order_date, subtotal, discount_amount, tax_amount, total, status, receipt_number)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(server_id, client_uuid, device_id, order.shift_id || '', terminal_id || '',
    order.cashier_name || '', order.customer || 'Walk-in',
    order.created_at_local, order.subtotal || 0, order.discount_amount || 0,
    order.tax_amount || 0, order.total || 0, order.status || 'completed', receipt);

  const insertItem = db.prepare(`
    INSERT INTO order_items (order_server_id, item_uuid, item_name, qty, unit_price, line_discount, line_total, tax_rate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const item of items) {
    insertItem.run(server_id, item.product_uuid, item.product_name, item.qty,
      item.unit_price, item.line_discount || 0, item.line_total, item.tax_rate || 0);
  }

  const insertPmt = db.prepare(`
    INSERT INTO payments (order_server_id, method, amount, tendered, change_given)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const p of payments) {
    insertPmt.run(server_id, p.method, p.amount, p.tendered || p.amount, p.change_given || 0);
  }
}

function processRefund(server_id, client_uuid, payload, device_id) {
  const orderServerRow = db.prepare('SELECT server_id FROM sync_log WHERE entity_uuid = ?').get(payload.order_uuid);
  db.prepare(`
    INSERT OR REPLACE INTO refunds
    (server_id, client_uuid, order_client_uuid, order_server_id, reason, amount, status, device_id, refund_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(server_id, client_uuid, payload.order_uuid, orderServerRow?.server_id || null,
    payload.reason, payload.amount, payload.status || 'processed', device_id,
    payload.created_at_local);

  // Update order status
  if (orderServerRow) {
    db.prepare("UPDATE orders SET status = 'refunded', updated_at = datetime('now') WHERE server_id = ?")
      .run(orderServerRow.server_id);
  }
}

function processShift(server_id, client_uuid, payload, device_id) {
  const existing = db.prepare('SELECT id FROM shifts WHERE client_uuid = ?').get(client_uuid);
  if (existing) {
    if (payload.status === 'closed') {
      db.prepare(`
        UPDATE shifts SET status = 'closed', closed_at = ?, expected_cash = ?, counted_cash = ?, variance = ?
        WHERE client_uuid = ?
      `).run(payload.closed_at, payload.expected_cash, payload.counted_cash, payload.variance, client_uuid);
    }
    return;
  }
  db.prepare(`
    INSERT INTO shifts (server_id, client_uuid, device_id, cashier_id, opened_at, float_amount, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(server_id, client_uuid, device_id, payload.cashier_id || '', payload.opened_at,
    payload.float_amount || 0, payload.status || 'open');
}

function processCashEvent(server_id, client_uuid, payload, device_id) {
  db.prepare(`
    INSERT OR IGNORE INTO cash_events (server_id, client_uuid, shift_client_uuid, type, amount, reason, device_id, event_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(server_id, client_uuid, payload.shift_id || '', payload.type || 'in',
    payload.amount || 0, payload.reason || '', device_id, payload.created_at_local);
}

/**
 * GET /sync/pull?since=ISO_DATE
 * Returns catalog and config updates since the given timestamp.
 */
app.get('/sync/pull', requireAuth, (req, res) => {
  const since = req.query.since || '1970-01-01T00:00:00Z';

  const products = db.prepare(`
    SELECT uuid, sku, barcode, name, category_uuid as category, price, tax_rate,
           emoji, active, stock, track_stock, updated_at
    FROM catalog_products WHERE updated_at >= ?
  `).all(since);

  const categories = db.prepare(`
    SELECT uuid, name, updated_at FROM catalog_categories WHERE updated_at >= ?
  `).all(since);

  res.json({
    products,
    categories,
    updated_at: new Date().toISOString(),
    count: products.length
  });
});

// ── ADMIN CATALOG MANAGEMENT ──────────────────────────────────────────

/**
 * POST /admin/catalog/products
 * Upsert products into catalog
 */
app.post('/admin/catalog/products', requireAuth, (req, res) => {
  const { products = [] } = req.body;
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO catalog_products (uuid, sku, barcode, name, category_uuid, price, tax_rate, emoji, active, stock, track_stock, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const insertMany = db.transaction(prods => prods.forEach(p => upsert.run(
    p.uuid || uuidv4(), p.sku || '', p.barcode || '', p.name, p.category || p.category_uuid || '',
    p.price || 0, p.tax_rate || 0, p.emoji || '📦', p.active !== false ? 1 : 0,
    p.stock || 0, p.track_stock !== false ? 1 : 0
  )));
  insertMany(products);
  res.json({ ok: true, count: products.length });
});

/**
 * POST /admin/catalog/categories
 * Upsert categories
 */
app.post('/admin/catalog/categories', requireAuth, (req, res) => {
  const { categories = [] } = req.body;
  const upsert = db.prepare(`INSERT OR REPLACE INTO catalog_categories (uuid, name, updated_at) VALUES (?, ?, datetime('now'))`);
  db.transaction(cats => cats.forEach(c => upsert.run(c.uuid || uuidv4(), c.name)))(categories);
  res.json({ ok: true, count: categories.length });
});

/**
 * GET /admin/orders
 * List orders with pagination
 */
app.get('/admin/orders', requireAuth, (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;
  const orders = db.prepare('SELECT * FROM orders ORDER BY order_date DESC LIMIT ? OFFSET ?').all(limit, offset);
  const total = db.prepare('SELECT COUNT(*) as cnt FROM orders').get().cnt;
  res.json({ orders, total, limit, offset });
});

/**
 * GET /admin/reports/summary
 * Revenue summary
 */
app.get('/admin/reports/summary', requireAuth, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const stats = {
    total_orders: db.prepare("SELECT COUNT(*) as cnt FROM orders WHERE status = 'completed'").get().cnt,
    total_revenue: db.prepare("SELECT COALESCE(SUM(total), 0) as s FROM orders WHERE status = 'completed'").get().s,
    today_orders: db.prepare("SELECT COUNT(*) as cnt FROM orders WHERE status = 'completed' AND order_date >= ?").get(today).cnt,
    today_revenue: db.prepare("SELECT COALESCE(SUM(total), 0) as s FROM orders WHERE status = 'completed' AND order_date >= ?").get(today).s,
    total_tax: db.prepare("SELECT COALESCE(SUM(tax_amount), 0) as s FROM orders WHERE status = 'completed'").get().s,
    by_method: db.prepare("SELECT p.method, COALESCE(SUM(p.amount), 0) as total FROM payments p JOIN orders o ON p.order_server_id = o.server_id WHERE o.status = 'completed' GROUP BY p.method").all()
  };
  res.json(stats);
});

// ── START ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║     EnZo POS — Sync Backend          ║
  ║     Listening on port ${PORT}           ║
  ║     Token: ${API_TOKEN.slice(0,12)}...     ║
  ╚══════════════════════════════════════╝
  `);
});

module.exports = app;
