const fs = require('fs');
const path = require('path');

// Try to load paj_ramp SDK
let pajSdk = null;
try {
  pajSdk = require('paj_ramp');
} catch (err) {
  console.error('⚠️  paj_ramp SDK not available:', err.message);
}

const PAJ_API_KEY = process.env.PAJ_API_KEY;
const PAJ_ENV = process.env.PAJ_ENV || 'production';
const SESSION_PATH = path.join(__dirname, 'paj-session.json');
const SETTINGS_PATH = path.join(__dirname, 'settings.json');

function getPajEmail() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
      if (settings.paj_email) return settings.paj_email;
    }
  } catch (err) {}
  return process.env.PAJ_EMAIL || 'paj@usevelcro.com';
}

// Initialize PAJ SDK environment
if (pajSdk) {
  try {
    const env = PAJ_ENV === 'production' ? pajSdk.Environment.Production : pajSdk.Environment.Staging;
    pajSdk.initializeSDK(env);
    console.log(`✅ PAJ SDK initialized (${PAJ_ENV})`);
  } catch (err) {
    console.error('⚠️  PAJ SDK init failed:', err.message);
  }
}

// Token mint addresses on Solana
const PAJ_ASSETS = [
  {
    id: 'sol',
    symbol: 'SOL',
    name: 'Solana',
    mint: 'So11111111111111111111111111111111111111112',
    chain: 'SOLANA',
    logo: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png'
  },
  {
    id: 'jup',
    symbol: 'JUP',
    name: 'Jupiter',
    mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    chain: 'SOLANA',
    logo: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN/logo.png'
  },
  {
    id: 'usdg',
    symbol: 'USDG',
    name: 'USDC',
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    chain: 'SOLANA',
    logo: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png'
  }
];

function loadSession() {
  try {
    if (fs.existsSync(SESSION_PATH)) {
      return JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8'));
    }
  } catch (err) {
    console.error('Failed to load PAJ session:', err.message);
  }
  return null;
}

function saveSession(session) {
  try {
    fs.writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2));
    return true;
  } catch (err) {
    console.error('Failed to save PAJ session:', err.message);
    return false;
  }
}

function isSessionValid(session) {
  if (!session || !session.token) return false;
  if (session.expiresAt) {
    return new Date(session.expiresAt) > new Date();
  }
  return true;
}

// Initiate PAJ session (sends OTP)
async function initiateSession() {
  if (!pajSdk || !PAJ_API_KEY) {
    throw new Error('PAJ SDK not available or API key missing');
  }
  try {
    const email = getPajEmail();
    const result = await pajSdk.initiate(email, PAJ_API_KEY);
    return { success: true, email, message: 'OTP sent to email' };
  } catch (err) {
    throw new Error('PAJ initiate failed: ' + err.message);
  }
}

// Verify PAJ session with OTP
async function verifySession(otp) {
  if (!pajSdk || !PAJ_API_KEY) {
    throw new Error('PAJ SDK not available or API key missing');
  }
  try {
    const device = {
      uuid: 'velcro-server-' + Date.now(),
      device: 'Server',
      os: 'Linux',
      browser: 'Node.js',
      ip: '127.0.0.1'
    };
    const result = await pajSdk.verify(getPajEmail(), otp, device, PAJ_API_KEY);
    const session = {
      token: result.token,
      recipient: result.recipient,
      isActive: result.isActive,
      expiresAt: result.expiresAt,
      createdAt: new Date().toISOString()
    };
    saveSession(session);
    return { success: true, session };
  } catch (err) {
    throw new Error('PAJ verification failed: ' + err.message);
  }
}

// Get valid session token (initiates if needed)
async function getSessionToken() {
  const session = loadSession();
  if (isSessionValid(session)) {
    return session.token;
  }
  throw new Error('PAJ session expired. Please initiate and verify OTP via admin dashboard.');
}

// Get PAJ rates
async function getPajRate() {
  if (!pajSdk || !PAJ_API_KEY) {
    throw new Error('PAJ SDK not available');
  }
  try {
    const result = await pajSdk.getAllRate();
    return {
      onramp: result?.onRampRate || null,
      offramp: result?.offRampRate || null
    };
  } catch (err) {
    throw new Error('PAJ rate fetch failed: ' + err.message);
  }
}

// Get token value (fiat → token)
async function getTokenValue(fiatAmount, mint) {
  const token = await getSessionToken();
  try {
    const result = await pajSdk.getTokenValue(
      { amount: fiatAmount, mint, currency: pajSdk.Currency.NGN },
      token
    );
    return result;
  } catch (err) {
    throw new Error('PAJ token value fetch failed: ' + err.message);
  }
}

// Create onramp order
async function createOnrampOrder({ fiatAmount, recipient, mint, webhookURL }) {
  const token = await getSessionToken();
  try {
    const result = await pajSdk.createOnrampOrder(
      {
        fiatAmount,
        currency: pajSdk.Currency.NGN,
        recipient,
        mint,
        chain: pajSdk.Chain.SOLANA,
        webhookURL: webhookURL || `${process.env.CALLBACK_URL || ''}/webhook/paj`
      },
      token
    );
    return result;
  } catch (err) {
    throw new Error('PAJ onramp order failed: ' + err.message);
  }
}

// Get transaction status
async function getTransactionStatus(txId) {
  const token = await getSessionToken();
  try {
    const result = await pajSdk.getTransaction(token, txId);
    return result;
  } catch (err) {
    throw new Error('PAJ transaction fetch failed: ' + err.message);
  }
}

// Get PAJ assets list
function getAssets() {
  return PAJ_ASSETS;
}

// Get session status
function getSessionStatus() {
  const session = loadSession();
  return {
    hasSession: !!session,
    isValid: isSessionValid(session),
    email: getPajEmail(),
    expiresAt: session?.expiresAt || null
  };
}

module.exports = {
  initiateSession,
  verifySession,
  getSessionToken,
  getPajRate,
  getTokenValue,
  createOnrampOrder,
  getTransactionStatus,
  getAssets,
  getSessionStatus,
  PAJ_ASSETS
};
