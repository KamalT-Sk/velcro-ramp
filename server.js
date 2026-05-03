require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const { randomUUID } = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
app.set('trust proxy', 1); // Trust first proxy (Nginx)
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/velcro_ramp';
const SWITCH_BASE_URL = process.env.SWITCH_BASE_URL || 'https://api.onswitch.xyz';
const SWITCH_SERVICE_KEY = process.env.SWITCH_SERVICE_KEY;
const DEVELOPER_FEE = parseFloat(process.env.DEVELOPER_FEE) || 0.5;
const DEVELOPER_RECIPIENT = process.env.DEVELOPER_RECIPIENT || '8hM6fCeFrBZAenN8HdQDZ6qN7G5Yv8qu34VJFy95mejh';
const DEVELOPER_WITHDRAW_ASSET = process.env.DEVELOPER_WITHDRAW_ASSET || 'solana:usdc';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'velcroadmin2026';

// ─── Auto-Withdrawal Logic ───
async function autoWithdrawFees() {
  if (!DEVELOPER_RECIPIENT || DEVELOPER_RECIPIENT === 'your_actual_wallet_address') return;
  
  try {
    console.log('🔄 Checking accumulated developer fees...');
    const feesData = await switchApi('/developer/fees');
    
    if (feesData.success && feesData.data && feesData.data.amount > 1) { // Withdraw if > $1
      console.log(`💰 Found $${feesData.data.amount} in fees. Initiating withdrawal to ${DEVELOPER_RECIPIENT}...`);
      
      const withdrawData = await switchApi('/developer/withdraw', {
        method: 'POST',
        body: JSON.stringify({
          asset: DEVELOPER_WITHDRAW_ASSET,
          beneficiary: {
            wallet_address: DEVELOPER_RECIPIENT
          }
        })
      });
      
      if (withdrawData.success) {
        console.log(`✅ Fee withdrawal initiated! Hash: ${withdrawData.data?.hash}`);
      } else {
        console.error(`❌ Fee withdrawal failed: ${withdrawData.message}`);
      }
    } else {
      console.log('ℹ️ Fee balance too low or not fetched.');
    }
  } catch (err) {
    console.error('❌ Error in auto-withdrawal:', err.message);
  }
}

// Run withdrawal check every hour
setInterval(autoWithdrawFees, 60 * 60 * 1000);
// Run once on startup after 30 seconds
setTimeout(autoWithdrawFees, 30 * 1000);

// ─── MongoDB Schema ───
const transactionSchema = new mongoose.Schema({
  reference: { type: String, unique: true, required: true, index: true },
  switch_reference: { type: String, index: true },
  type: { type: String, required: true, enum: ['OFFRAMP', 'ONRAMP'], index: true },
  status: { type: String, default: 'AWAITING_DEPOSIT', index: true },
  country: { type: String, required: true, index: true },
  currency: { type: String, required: true },
  asset: { type: String, required: true },
  channel: { type: String, default: 'BANK' },
  amount: { type: Number, required: true },
  rate: Number,
  fee_total: Number,
  fee_platform: Number,
  fee_developer: Number,
  source_amount: Number,
  source_currency: String,
  destination_amount: Number,
  destination_currency: String,
  deposit_address: String,
  deposit_bank_name: String,
  deposit_account_number: String,
  deposit_account_name: String,
  deposit_note: String,
  beneficiary: String, // Stringified JSON
  wallet_address: String,
  hash: String,
  explorer_url: String,
  callback_url: String,
  meta: String, // Stringified JSON
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

const Transaction = mongoose.model('Transaction', transactionSchema);

// ─── Database Connection ───
mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

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

app.get('/api/health', (req, res) => {
  res.json(successResponse({ service: 'velcro-backend', version: '1.2.0', db: 'mongodb' }));
});

app.get('/api/assets', async (req, res, next) => {
  try {
    const data = await switchApi('/asset');
    res.json(data);
  } catch (err) { next(err); }
});

app.get('/api/rates', async (req, res, next) => {
  try {
    const { country, currency } = req.query;
    let path = '/rates';
    const params = new URLSearchParams();
    if (country) params.append('country', country);
    if (currency) params.append('currency', currency);
    const qs = params.toString();
    if (qs) path += '?' + qs;
    const data = await switchApi(path);
    res.json(data);
  } catch (err) { next(err); }
});

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
      reason: reason || 'PERSONAL_TRANSFER',
      narration: 'Velcro Settlement',
      ...(DEVELOPER_RECIPIENT ? { developer_fee: DEVELOPER_FEE, developer_recipient: DEVELOPER_RECIPIENT } : {})
    };
    if (callback_url) payload.callback_url = callback_url;

    if (direction === 'OFFRAMP') {
      payload.static = false;
      payload.sender_name = 'Velcro Ramp';
    } else if (direction === 'ONRAMP' && wallet_address) {
      payload.wallet_address = wallet_address;
    }

    const data = await switchApi(endpoint, {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    const d = data.data || {};
    const dep = d.deposit || {};
    const fee = d.fee || {};
    const src = d.source || {};
    const dst = d.destination || {};

    await Transaction.create({
      reference: txRef,
      switch_reference: d.id || d.reference || null,
      type: direction,
      status: d.status || 'AWAITING_DEPOSIT',
      country,
      currency: currency || (direction === 'ONRAMP' ? src.currency : dst.currency) || 'NGN',
      asset,
      channel: channel || 'BANK',
      amount,
      rate: d.rate || null,
      fee_total: fee.total || null,
      fee_platform: fee.platform || null,
      fee_developer: fee.developer || null,
      source_amount: src.amount || null,
      source_currency: src.currency || null,
      destination_amount: dst.amount || null,
      destination_currency: dst.currency || null,
      deposit_address: dep.address || null,
      deposit_bank_name: dep.bank_name || null,
      deposit_account_number: dep.account_number || null,
      deposit_account_name: dep.account_name || null,
      deposit_note: Array.isArray(dep.note) ? dep.note.join('\n') : dep.note || null,
      beneficiary: beneficiary ? JSON.stringify(beneficiary) : null,
      wallet_address: wallet_address || null,
      callback_url: callback_url || null,
      meta: JSON.stringify(d)
    });

    res.json(data);
  } catch (err) { next(err); }
});

// Update to use /payment/status
app.get('/api/status', async (req, res, next) => {
  try {
    const { reference } = req.query;
    if (!reference) return res.status(400).json(errorResponse('reference is required'));

    const data = await switchApi(`/payment/status?reference=${encodeURIComponent(reference)}`);
    const d = data.data || {};

    if (d.status) {
      await Transaction.findOneAndUpdate(
        { reference },
        { 
          status: d.status, 
          hash: (d.meta && d.meta.hash) || d.hash || null, 
          explorer_url: (d.meta && d.meta.explorer_url) || d.explorer_url || null 
        },
        { new: true }
      );
    }

    res.json(data);
  } catch (err) { next(err); }
});

// Update to use /payment/confirm
app.post('/api/confirm', async (req, res, next) => {
  try {
    const { reference, hash } = req.body;
    if (!reference) return res.status(400).json(errorResponse('reference is required'));

    const tx = await Transaction.findOne({ reference });
    if (!tx) return res.status(404).json(errorResponse('Transaction not found'));

    const payload = { reference };
    if (hash) payload.hash = hash;

    const data = await switchApi('/payment/confirm', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    const d = data.data || {};
    await Transaction.findOneAndUpdate(
      { reference },
      { status: d.status || 'PROCESSING', hash: hash || null }
    );

    res.json(data);
  } catch (err) { next(err); }
});

app.get('/api/transactions', async (req, res) => {
  const { type, country, status, limit = 50, offset = 0 } = req.query;
  const query = {};
  if (type) query.type = type;
  if (country) query.country = country;
  if (status) query.status = status;

  const rows = await Transaction.find(query)
    .sort({ created_at: -1 })
    .limit(parseInt(limit))
    .skip(parseInt(offset));
    
  res.json(successResponse(rows));
});

app.get('/api/transactions/:reference', async (req, res) => {
  const row = await Transaction.findOne({ reference: req.params.reference });
  if (!row) return res.status(404).json(errorResponse('Transaction not found', 404));
  res.json(successResponse(row));
});

app.get('/api/history', async (req, res, next) => {
  try {
    const { limit = 20, offset = 0, status, direction } = req.query;
    const params = new URLSearchParams();
    params.append('limit', limit);
    params.append('offset', offset);
    if (status) params.append('status', status);
    if (direction) params.append('direction', direction);
    const data = await switchApi(`/payment/history?${params.toString()}`);
    res.json(data);
  } catch (err) { next(err); }
});

// Improved Webhook
app.post('/webhook/switch', express.json(), async (req, res) => {
  try {
    const payload = req.body;
    console.log('[Webhook Received]', JSON.stringify(payload));
    
    // Switch often sends: { event, reference, status, data: { ... } }
    const reference = payload.reference || (payload.data && payload.data.reference);
    const status = payload.status || (payload.data && payload.data.status);

    if (reference && status) {
      await Transaction.findOneAndUpdate(
        { reference },
        { 
          status, 
          meta: JSON.stringify(payload),
          hash: (payload.data && payload.data.hash) || null,
          explorer_url: (payload.data && payload.data.explorer_url) || null
        }
      );
      console.log(`[Webhook] Updated status of ${reference} to ${status}`);
    }

    res.json({ success: true, received: true });
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.json({ success: false, error: err.message });
  }
});

// ─── Admin Endpoints ───
const adminAuth = (req, res, next) => {
  const auth = req.headers.authorization;
  if (auth && (auth === `Bearer ${ADMIN_PASSWORD}` || auth === ADMIN_PASSWORD)) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
};

app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const allTxs = await Transaction.find({});
    const totalUsers = new Set(allTxs.map(t => t.wallet_address).filter(Boolean)).size;
    const completedTxs = allTxs.filter(t => t.status === 'COMPLETED');
    
    const volumeUSD = completedTxs.reduce((sum, t) => sum + (t.type === 'OFFRAMP' ? t.amount : (t.destination_amount || 0)), 0);
    const volumeNGN = completedTxs.reduce((sum, t) => sum + (t.type === 'ONRAMP' ? t.amount : (t.destination_amount || 0)), 0);

    // Get current balance from Switch
    const feesData = await switchApi('/developer/fees').catch(() => ({ data: { amount: 0 } }));

    res.json({
      totalUsers,
      allTransactions: allTxs.length,
      completedTransactions: completedTxs.length,
      totalVolumeUSD: volumeUSD,
      totalVolumeNGN: volumeNGN,
      developerFees: feesData.data || { amount: 0, currency: 'USD' }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/transactions', adminAuth, async (req, res) => {
  const rows = await Transaction.find({}).sort({ created_at: -1 }).limit(200);
  res.json(rows);
});

app.get('/api/admin/users', adminAuth, async (req, res) => {
  const txs = await Transaction.find({});
  const userMap = {};
  
  txs.forEach(t => {
    const id = t.wallet_address || 'unknown';
    if (!userMap[id]) {
      userMap[id] = { id, total_volume: 0, total_volume_ngn: 0, tx_count: 0, created_at: t.created_at };
    }
    if (t.status === 'COMPLETED') {
      userMap[id].total_volume += (t.type === 'OFFRAMP' ? t.amount : (t.destination_amount || 0));
      userMap[id].total_volume_ngn += (t.type === 'ONRAMP' ? t.amount : (t.destination_amount || 0));
    }
    userMap[id].tx_count++;
    if (t.created_at < userMap[id].created_at) userMap[id].created_at = t.created_at;
  });

  const users = Object.values(userMap).sort((a, b) => b.total_volume - a.total_volume);
  res.json(users);
});

app.post('/api/admin/withdraw', adminAuth, async (req, res) => {
  try {
    const { asset } = req.body;
    const data = await switchApi('/developer/withdraw', {
      method: 'POST',
      body: JSON.stringify({
        asset: asset || DEVELOPER_WITHDRAW_ASSET,
        beneficiary: { wallet_address: DEVELOPER_RECIPIENT }
      })
    });
    if (data.success) {
      res.json({ success: true, data: data.data });
    } else {
      res.status(400).json({ success: false, error: data.message });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/settings', adminAuth, async (req, res) => {
  res.json({ platform_fee: DEVELOPER_FEE });
});

// ─── Static Files ───
const adminPath = path.join(__dirname, 'admin');
if (fs.existsSync(adminPath)) {
  app.use('/admin', express.static(adminPath));
}

const staticPath = path.join(__dirname, 'public');
if (fs.existsSync(staticPath)) {
  app.use(express.static(staticPath));
  app.get('*', (req, res) => {
    // If it starts with /admin, don't redirect to public index
    if (req.path.startsWith('/admin')) {
      return res.sendFile(path.join(adminPath, 'index.html'));
    }
    res.sendFile(path.join(staticPath, 'index.html'));
  });
}

app.use((err, req, res, next) => {
  const status = err.response?.status || err.status || 500;
  const message = err.response?.data?.message || err.message || 'Internal Server Error';
  console.error(`[${req.method}] ${req.path} Error (${status}):`, message);
  res.status(status).json({
    status: 'ERROR',
    message: message
  });
});

app.listen(PORT, () => {
  console.log(`\n🚀 Velcro Backend v1.2.0 running at: http://localhost:${PORT}`);
  console.log(`🔌 Switch Base URL: ${SWITCH_BASE_URL}`);
  console.log(`💰 Developer Fee: ${DEVELOPER_FEE}%`);
  console.log(`🌍 Supported: NG (NGN) only`);
  console.log(`🍃 Database: MongoDB\n`);
});

module.exports = app;
