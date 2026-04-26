require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const { randomUUID } = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const SWITCH_BASE_URL = process.env.SWITCH_BASE_URL || 'https://switch-v2.up.railway.app';
const SWITCH_SERVICE_KEY = process.env.SWITCH_SERVICE_KEY;
const DEVELOPER_FEE = parseFloat(process.env.DEVELOPER_FEE) || 0.5;
const DEVELOPER_RECIPIENT = process.env.DEVELOPER_RECIPIENT || '';

// ─── Middleware ───
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false,
}));

const corsOrigins = (process.env.CORS_ORIGINS || '*').split(',').map(s => s.trim());
app.use(cors({
  origin: corsOrigins.includes('*') ? true : corsOrigins,
  methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '1mb' }));

const limiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// ─── SQLite Database ───
const dbPath = path.join(__dirname, 'database.sqlite');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reference TEXT UNIQUE NOT NULL,
    switch_reference TEXT,
    type TEXT NOT NULL CHECK(type IN ('OFFRAMP','ONRAMP')),
    status TEXT DEFAULT 'PENDING',
    country TEXT NOT NULL,
    currency TEXT NOT NULL,
    asset TEXT NOT NULL,
    channel TEXT DEFAULT 'BANK',
    amount REAL NOT NULL,
    rate REAL,
    fee_total REAL,
    fee_platform REAL,
    fee_developer REAL,
    source_amount REAL,
    source_currency TEXT,
    destination_amount REAL,
    destination_currency TEXT,
    deposit_address TEXT,
    deposit_bank_name TEXT,
    deposit_account_number TEXT,
    deposit_account_name TEXT,
    deposit_note TEXT,
    beneficiary TEXT,
    wallet_address TEXT,
    hash TEXT,
    explorer_url TEXT,
    callback_url TEXT,
    meta TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_transactions_reference ON transactions(reference);
  CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
  CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
  CREATE INDEX IF NOT EXISTS idx_transactions_country ON transactions(country);
`);

// ─── Switch API Client ───
async function switchApi(endpoint, options = {}) {
  const url = `${SWITCH_BASE_URL}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'x-service-key': SWITCH_SERVICE_KEY,
    ...(options.headers || {}),
  };

  const res = await fetch(url, {
    ...options,
    headers,
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!res.ok) {
    const err = new Error(data.message || `Switch API error: ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ─── Helpers ───
function successResponse(data, message = 'Success') {
  return { success: true, message, timestamp: new Date().toISOString(), data };
}

function errorResponse(message, status = 400) {
  return { success: false, message, timestamp: new Date().toISOString(), status };
}

// ─── Routes ───

// Health
app.get('/api/health', (req, res) => {
  res.json(successResponse({ service: 'velcro-backend', version: '1.0.0', env: process.env.NODE_ENV }));
});

// Get supported assets
app.get('/api/assets', async (req, res, next) => {
  try {
    const data = await switchApi('/asset');
    res.json(data);
  } catch (err) { next(err); }
});

// Get coverage
app.get('/api/coverage', async (req, res, next) => {
  try {
    const { direction, country, currency } = req.query;
    const params = new URLSearchParams();
    if (direction) params.append('direction', direction);
    if (country) params.append('country', country);
    if (currency) params.append('currency', currency);
    const qs = params.toString();
    const data = await switchApi(`/coverage${qs ? '?' + qs : ''}`);
    res.json(data);
  } catch (err) { next(err); }
});

// Get countries
app.get('/api/countries', async (req, res, next) => {
  try {
    const data = await switchApi('/country');
    res.json(data);
  } catch (err) { next(err); }
});

// Get states
app.get('/api/states', async (req, res, next) => {
  try {
    const { country } = req.query;
    if (!country) return res.status(400).json(errorResponse('country is required'));
    const data = await switchApi(`/state?country=${encodeURIComponent(country)}`);
    res.json(data);
  } catch (err) { next(err); }
});

// Get institutions (Banks)
app.get('/api/institutions', async (req, res, next) => {
  try {
    const { country, currency, channel } = req.query;
    const params = new URLSearchParams();
    if (country) params.append('country', country);
    if (currency) params.append('currency', currency);
    if (channel) params.append('channel', channel);
    
    let path = '/institution';
    const qs = params.toString();
    if (qs) path += '?' + qs;

    const data = await switchApi(path);
    res.json(data);
  } catch (err) { next(err); }
});

// Resolve Account Name
app.post('/api/resolve', async (req, res, next) => {
  try {
    const { country, beneficiary } = req.body;
    if (!country || !beneficiary) {
      return res.status(400).json(errorResponse('country and beneficiary are required'));
    }
    const data = await switchApi('/institution/lookup', {
      method: 'POST',
      body: JSON.stringify({ country, beneficiary }),
    });
    res.json(data);
  } catch (err) { next(err); }
});

// Get requirements
app.get('/api/requirements', async (req, res, next) => {
  try {
    const { direction, country, currency, type, channel } = req.query;
    if (!direction || !country) {
      return res.status(400).json(errorResponse('direction and country are required'));
    }
    const params = new URLSearchParams();
    params.append('direction', direction);
    params.append('country', country);
    if (currency) params.append('currency', currency);
    if (type) params.append('type', type);
    if (channel) params.append('channel', channel);
    const data = await switchApi(`/requirement?${params.toString()}`);
    res.json(data);
  } catch (err) { next(err); }
});

// Get rate
app.post('/api/rate', async (req, res, next) => {
  try {
    const { direction, asset, country, currency, channel } = req.body;
    if (!direction || !country) {
      return res.status(400).json(errorResponse('direction and country are required'));
    }
    const endpoint = direction === 'ONRAMP' ? '/onramp/rate' : '/offramp/rate';
    const data = await switchApi(endpoint, {
      method: 'POST',
      body: JSON.stringify({ asset, country, currency, channel }),
    });
    res.json(data);
  } catch (err) { next(err); }
});

// Get quote
app.post('/api/quote', async (req, res, next) => {
  try {
    const { direction, amount, country, asset, currency, channel, exact_output } = req.body;
    if (!direction || !amount || !country || !asset) {
      return res.status(400).json(errorResponse('direction, amount, country, and asset are required'));
    }
    const endpoint = direction === 'ONRAMP' ? '/onramp/quote' : '/offramp/quote';
    const payload = {
      amount,
      country,
      asset,
      currency,
      channel,
      exact_output: exact_output ?? false,
    };
    if (DEVELOPER_RECIPIENT) {
      payload.developer_fee = DEVELOPER_FEE;
      payload.developer_recipient = DEVELOPER_RECIPIENT;
    }
    const data = await switchApi(endpoint, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    res.json(data);
  } catch (err) { next(err); }
});

// Initiate transaction
app.post('/api/initiate', async (req, res, next) => {
  try {
    const {
      direction, amount, country, asset, currency, channel,
      beneficiary, callback_url, reference, reason, exact_output,
      wallet_address, sender_name
    } = req.body;

    if (!direction || !amount || !country || !asset) {
      return res.status(400).json(errorResponse('direction, amount, country, and asset are required'));
    }

    const txRef = reference || randomUUID();
    const endpoint = direction === 'ONRAMP' ? '/onramp/initiate' : '/offramp/initiate';

    const payload = {
      amount,
      country,
      asset,
      currency,
      channel,
      beneficiary,
      exact_output: exact_output ?? false,
      reference: txRef,
      reason,
      ...(DEVELOPER_RECIPIENT ? { developer_fee: DEVELOPER_FEE, developer_recipient: DEVELOPER_RECIPIENT } : {})
    };
    if (callback_url) payload.callback_url = callback_url;

    if (direction === 'OFFRAMP') {
      payload.static = false;
      if (sender_name) payload.sender_name = sender_name;
    }

    const data = await switchApi(endpoint, {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    // Store in local DB
    const stmt = db.prepare(`
      INSERT INTO transactions (
        reference, switch_reference, type, status, country, currency, asset, channel,
        amount, rate, fee_total, fee_platform, fee_developer,
        source_amount, source_currency, destination_amount, destination_currency,
        deposit_address, deposit_bank_name, deposit_account_number, deposit_account_name,
        deposit_note, beneficiary, wallet_address, callback_url, meta
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const d = data.data || {};
    const dep = d.deposit || {};
    const fee = d.fee || {};
    const src = d.source || {};
    const dst = d.destination || {};

    stmt.run(
      txRef,
      d.id || d.reference || null,
      direction,
      d.status || 'PENDING',
      country,
      currency || (direction === 'ONRAMP' ? src.currency : dst.currency) || 'NGN',
      asset,
      channel || 'BANK',
      amount,
      d.rate || null,
      fee.total || null,
      fee.platform || null,
      fee.developer || null,
      src.amount || null,
      src.currency || null,
      dst.amount || null,
      dst.currency || null,
      dep.address || null,
      dep.bank_name || null,
      dep.account_number || null,
      dep.account_name || null,
      Array.isArray(dep.note) ? dep.note.join('\n') : dep.note || null,
      beneficiary ? JSON.stringify(beneficiary) : null,
      wallet_address || null,
      callback_url || null,
      JSON.stringify(d)
    );

    res.json(data);
  } catch (err) { next(err); }
});

// Get transaction status
app.get('/api/status', async (req, res, next) => {
  try {
    const { reference } = req.query;
    if (!reference) return res.status(400).json(errorResponse('reference is required'));

    const data = await switchApi(`/status?reference=${encodeURIComponent(reference)}`);

    // Update local DB if we have this transaction
    const d = data.data || {};
    if (d.status) {
      db.prepare(`UPDATE transactions SET status = ?, updated_at = datetime('now'), hash = ?, explorer_url = ? WHERE reference = ?`)
        .run(d.status, d.hash || null, d.explorer_url || null, reference);
    }

    res.json(data);
  } catch (err) { next(err); }
});

// Confirm payment deposit
app.post('/api/confirm', async (req, res, next) => {
  try {
    const { reference, hash } = req.body;
    if (!reference) return res.status(400).json(errorResponse('reference is required'));
    if (!hash) return res.status(400).json(errorResponse('transaction hash is required'));

    const data = await switchApi('/payment/confirm-deposit', {
      method: 'POST',
      body: JSON.stringify({ reference, hash }),
    });

    db.prepare(`UPDATE transactions SET status = 'PROCESSING', hash = ?, updated_at = datetime('now') WHERE reference = ?`)
      .run(hash, reference);

    console.log(`[POST] /api/confirm - reference: ${reference} hash: ${hash}`);
    res.json(data);
  } catch (err) { next(err); }
});

// List local transactions
app.get('/api/transactions', (req, res) => {
  const { type, country, status, limit = 50, offset = 0 } = req.query;
  let sql = 'SELECT * FROM transactions WHERE 1=1';
  const params = [];
  if (type) { sql += ' AND type = ?'; params.push(type); }
  if (country) { sql += ' AND country = ?'; params.push(country); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), parseInt(offset));

  const rows = db.prepare(sql).all(...params);
  res.json(successResponse(rows));
});

// Get single local transaction
app.get('/api/transactions/:reference', (req, res) => {
  const row = db.prepare('SELECT * FROM transactions WHERE reference = ?').get(req.params.reference);
  if (!row) return res.status(404).json(errorResponse('Transaction not found', 404));
  res.json(successResponse(row));
});

// ─── Webhook ───

// Proxy: Resend webhook from Switch
app.post('/api/webhook/resend', async (req, res, next) => {
  try {
    const { reference } = req.body;
    if (!reference) return res.status(400).json(errorResponse('reference is required'));
    const data = await switchApi('/webhook/resend', {
      method: 'POST',
      body: JSON.stringify({ reference }),
    });
    res.json(data);
  } catch (err) { next(err); }
});

// Listener: Receive webhook from Switch
app.post('/webhook/switch', express.json(), (req, res) => {
  try {
    const payload = req.body;
    console.log('[Webhook Received]', JSON.stringify(payload));
    
    const reference = payload.reference || payload.data?.reference;
    const status = payload.status || payload.data?.status;

    if (reference && status) {
      db.prepare(`UPDATE transactions SET status = ?, meta = ?, updated_at = datetime('now') WHERE reference = ?`)
        .run(status, JSON.stringify(payload), reference);
      console.log(`[Webhook] Updated status of ${reference} to ${status}`);
    }

    res.json({ success: true, received: true });
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.json({ success: false, error: err.message });
  }
});

// ─── Serve Static Frontend ───
const staticPath = path.join(__dirname, 'public');
if (fs.existsSync(staticPath)) {
  app.use(express.static(staticPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(staticPath, 'index.html'));
  });
  console.log(` Serving static files from ${staticPath}`);
}

// ─── Error Handler ───
app.use((err, req, res, next) => {
  console.error(`[${req.method}] ${req.path} -`, err.message);
  const status = err.status || 500;
  res.status(status).json(errorResponse(err.message, status));
});

// ─── Start ───
app.listen(PORT, () => {
  console.log(` Velcro Backend running on port ${PORT}`);
  console.log(` Switch Base URL: ${SWITCH_BASE_URL}`);
  console.log(` Developer Fee: ${DEVELOPER_FEE}%`);
  console.log(` Supported: NG (NGN), GH (GHS), KE (KES)`);
});

module.exports = app;
