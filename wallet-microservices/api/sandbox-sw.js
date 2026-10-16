// Wallet API sandbox: answers the API page's "Try it out" calls inside the browser.
//
// Nothing reaches a server. This service worker intercepts requests to ./sandbox/ and
// answers them the way the wallet's gateway and services do: the gateway's 401, ownership
// checks (403), missing wallets (404), the Idempotency-Key rules (400, replay, 409),
// insufficient balance (422), the fee rules, and the same response shapes and messages.
// State (accounts, balances, history, tokens) is saved in this browser's Cache Storage,
// because the browser stops an idle worker after about 30 seconds. POST ./sandbox/__reset
// (the page's "Reset sandbox" button) puts the demo data back.
//
// Demo sign-in: demo@wallet.example / demo-password, then one-time code 123456.

const SANDBOX = new URL('./sandbox/', self.location).pathname; // e.g. /wallet-microservices/api/sandbox/
const OTP = '123456';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(SANDBOX)) return;
  event.respondWith(handle(event.request, '/' + url.pathname.slice(SANDBOX.length)));
});

// ---------------------------------------------------------------- money (integer cents)

class Money {
  constructor(cents) { this.cents = cents; }
  toJSON() { return `\u0000M${(this.cents / 100).toFixed(2)}\u0000`; }
}
const money = cents => new Money(cents);

/** JSON with money written as numbers with two decimals, like Jackson writes a BigDecimal. */
function toJson(value) {
  return JSON.stringify(value, null, 2).replace(/"\\u0000M(-?\d+\.\d{2})\\u0000"/g, '$1');
}

/** Parses an amount the way `new BigDecimal(x.toString())` would, as integer cents. */
function parseAmount(raw) {
  const text = String(raw).trim();
  if (!/^[-+]?\d+(\.\d+)?$/.test(text)) return { error: 'amount is not a number' };
  const [whole, frac = ''] = text.replace('+', '').split('.');
  if (frac.length > 2) return { scaleTooBig: true };
  return { cents: Math.round(Number(whole + '.' + (frac || '0')) * 100) };
}

// ---------------------------------------------------------------- state

const now = () => new Date().toISOString().slice(0, 19);
const uuid = () => crypto.randomUUID();
const CACHE = 'wallet-api-sandbox';
const STATE_URL = SANDBOX + '__state';
let users, wallets, history, pendingOtp, tokens, idempotency, nextUserId, nextWalletId, nextTxRow;

function seed() {
  nextUserId = 100;
  nextWalletId = 2000;
  nextTxRow = 312;
  users = new Map([
    [42, { userId: 42, fullName: 'Demo User', email: 'demo@wallet.example', phoneNumber: '+27825550142', password: 'demo-password', walletId: 1042 }],
    [77, { userId: 77, fullName: 'Thandi Mokoena', email: 'thandi@wallet.example', phoneNumber: '+27825550177', password: 'thandi-sandbox-only', walletId: 1077 }],
  ]);
  wallets = new Map([
    [1042, { walletId: 1042, userId: 42, merchantId: null, balance: 125000, currency: 'ZAR', walletAlias: 'demouser1760000000000', active: true, version: 7 }],
    [1077, { walletId: 1077, userId: 77, merchantId: null, balance: 30000, currency: 'ZAR', walletAlias: 'thandi1760000000001', active: true, version: 3 }],
  ]);
  history = [
    { id: 310, transactionId: '9d2e7b10-55c4-4c1f-a3f0-2e8b6c4d7a11', senderWalletId: null, recipientWalletId: 1042, merchantId: null,
      amount: 150000, transactionType: 'DEPOSIT', createdAt: '2026-10-10T08:15:22', description: 'Salary', currency: 'ZAR',
      status: 'COMPLETED', balanceBefore: 0, balanceAfter: 150000, userEmail: 'demo@wallet.example', userPhone: '+27825550142' },
    { id: 311, transactionId: '6f1c2b9e-4d3a-4b8e-9f21-0c7d5a1e8b42', senderWalletId: 1042, recipientWalletId: 1077, merchantId: null,
      amount: 25000, transactionType: 'TRANSFER', createdAt: '2026-10-11T17:40:03', description: 'Groceries split', currency: 'ZAR',
      status: 'COMPLETED', balanceBefore: 150000, balanceAfter: 125000, userEmail: 'demo@wallet.example', userPhone: '+27825550142' },
  ];
  pendingOtp = new Set();   // e-mails that passed sign-in step 1
  tokens = new Map([        // the token shown as the example in the API document is valid too
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZW1vQHdhbGxldC5leGFtcGxlIiwidXNlcklkIjo0Mn0.c2lnbmF0dXJl', 42],
  ]);
  idempotency = new Map();  // "user:{id}:{key}" -> { hash, text } (text = the stored response body)
}

const snapshot = () => ({
  users: [...users], wallets: [...wallets], history, pendingOtp: [...pendingOtp], tokens: [...tokens],
  idempotency: [...idempotency], next: { user: nextUserId, wallet: nextWalletId, row: nextTxRow },
});

function restore(saved) {
  users = new Map(saved.users);
  wallets = new Map(saved.wallets);
  history = saved.history;
  pendingOtp = new Set(saved.pendingOtp);
  tokens = new Map(saved.tokens);
  idempotency = new Map(saved.idempotency);
  ({ user: nextUserId, wallet: nextWalletId, row: nextTxRow } = saved.next);
}

let loading = null;
async function load() {
  try {
    const saved = await (await caches.open(CACHE)).match(STATE_URL);
    if (saved) { restore(await saved.json()); return; }
  } catch (e) { /* storage unavailable: start from the demo data */ }
  seed();
}

async function save() {
  try {
    await (await caches.open(CACHE)).put(STATE_URL,
      new Response(JSON.stringify(snapshot()), { headers: { 'Content-Type': 'application/json' } }));
  } catch (e) { /* storage unavailable: state lasts as long as the worker */ }
}

const findUser = id => [...users.values()].find(u => u.email === id || u.phoneNumber === id);
const walletByAlias = alias => [...wallets.values()].find(w => w.walletAlias === alias);
const walletView = w => ({ walletId: w.walletId, userId: w.userId, merchantId: w.merchantId, balance: money(w.balance),
  currency: w.currency, walletAlias: w.walletAlias, active: w.active, version: w.version });
const txView = t => ({ ...t, amount: money(t.amount), balanceBefore: t.balanceBefore == null ? null : money(t.balanceBefore),
  balanceAfter: t.balanceAfter == null ? null : money(t.balanceAfter) });

function issueToken(user) {
  const b64 = obj => btoa(JSON.stringify(obj)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const token = `${b64({ alg: 'HS256' })}.${b64({ sub: user.email, userId: user.userId, sandbox: true, iat: Math.floor(Date.now() / 1000) })}.c2FuZGJveA`;
  tokens.set(token, user.userId);
  return token;
}

// ---------------------------------------------------------------- responses

const HEADERS = { 'Content-Type': 'application/json', 'X-Sandbox': 'simulated' };
const reply = (status, body) => new Response(body === undefined ? null : toJson(body), { status, headers: HEADERS });
const error = (status, message) => reply(status, { error: message });
const gateway401 = () => reply(401, { error: 'Unauthorized', message: 'Missing or invalid Authorization header' });
const serverError = path => reply(500, { timestamp: new Date().toISOString(), path, status: 500,
  error: 'Internal Server Error', requestId: uuid().slice(0, 8) });

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------------------------------------------------------------- routing

const ROUTES = [
  // Fixed paths before templated ones, as Spring matches them.
  ['POST', '/oauth/login', login],
  ['POST', '/oauth/send-otp', sendOtp],
  ['POST', '/oauth2/token', token],
  ['POST', '/api/v1/walletusers/register', register],
  ['GET', '/api/v1/wallets/me', auth(myWallet)],
  ['GET', '/api/v1/wallets/user/balance', auth(myBalance)],
  ['POST', '/api/v1/wallets/topup', auth(topUp)],
  ['POST', '/api/v1/wallets/transfer', auth(transfer)],
  ['POST', '/api/v1/fees/calculate', auth(fee)],
  ['GET', '/api/v1/wallets/user/{userId}', auth(walletOfUser)],
  ['GET', '/api/v1/wallets/{id}/transactions', auth(transactions)],
  ['GET', '/api/v1/wallets/{id}/reconcile', auth(reconcile)],
  ['PUT', '/api/v1/wallets/{id}/balance', auth(withdraw)],
  ['GET', '/api/v1/wallets/{id}', auth(walletById)],
];

function match(template, path) {
  const t = template.split('/'), p = path.split('/');
  if (t.length !== p.length) return null;
  const params = {};
  for (let i = 0; i < t.length; i++) {
    if (t[i].startsWith('{')) params[t[i].slice(1, -1)] = decodeURIComponent(p[i]);
    else if (t[i] !== p[i]) return null;
  }
  return params;
}

async function handle(request, path) {
  await (loading ??= load());
  if (path === '/__reset' && request.method === 'POST') {
    seed();
    await save();
    return reply(200, { message: 'Sandbox reset to the demo data' });
  }
  const response = await route(request, path);
  if (request.method !== 'GET') await save();
  return response;
}

async function route(request, path) {
  let body = {};
  const text = request.method === 'GET' ? '' : await request.text();
  if (text) {
    try { body = JSON.parse(text); } catch { return error(400, 'Request body is not valid JSON'); }
  }
  for (const [method, template, fn] of ROUTES) {
    const params = match(template, path);
    if (!params || method !== request.method) continue;
    try {
      return await fn({ request, body, params, path: path });
    } catch (e) {
      if (e instanceof HttpError) return error(e.status, e.message);
      return serverError(path);
    }
  }
  return reply(404, { timestamp: new Date().toISOString(), path, status: 404, error: 'Not Found' });
}

/** The gateway's check: a valid Bearer token, else 401 before any service sees the call. */
function auth(fn) {
  return ctx => {
    const header = ctx.request.headers.get('Authorization') || '';
    const userId = header.startsWith('Bearer ') ? tokens.get(header.slice(7).trim()) : undefined;
    if (!userId) return gateway401();
    return fn({ ...ctx, userId });
  };
}

// ---------------------------------------------------------------- sign up and sign in

function login({ body }) {
  const user = findUser(body.email);
  if (!user || user.password !== body.password) return error(400, 'Invalid credentials');
  pendingOtp.add(user.email);
  return reply(200, { message: 'Credentials verified. OTP sent to your phone.' });
}

function sendOtp({ body }) {
  const user = findUser(body.email ?? body.phoneNumber);
  if (!user || user.password !== body.password) return error(400, 'Failed to send OTP');
  pendingOtp.add(user.email);
  return reply(200, { message: 'OTP sent successfully' });
}

function token({ body }) {
  if (body.grant_type !== 'otp') {
    return reply(400, { error: 'unsupported_grant_type', error_description: 'Grant type not supported' });
  }
  const user = findUser(body.username ?? body.phone_number);
  if (!user || !pendingOtp.has(user.email) || body.otp_code !== OTP) {
    return reply(400, { error: 'invalid_grant', error_description: 'Invalid OTP' });
  }
  pendingOtp.delete(user.email); // a code works once
  return reply(200, { access_token: issueToken(user), token_type: 'Bearer', expires_in: 3600, scope: 'read write' });
}

function register({ body }) {
  const { fullName, email, password, phoneNumber } = body;
  if (![fullName, email, password, phoneNumber].every(v => typeof v === 'string' && v.trim()) || findUser(email)) {
    return error(400, 'Registration failed');
  }
  const userId = nextUserId++;
  const walletId = nextWalletId++;
  users.set(userId, { userId, fullName, email, phoneNumber, password, walletId });
  wallets.set(walletId, { walletId, userId, merchantId: null, balance: 0, currency: 'ZAR',
    walletAlias: fullName.replace(/\s+/g, '').toLowerCase() + Date.now(), active: true, version: 0 });
  return reply(200, { message: 'User and wallet created successfully' });
}

// ---------------------------------------------------------------- reads

function owned(wallet, userId, label) {
  if (!wallet) throw new HttpError(404, `${label} not found`);
  if (wallet.userId !== userId) throw new HttpError(403, 'This wallet does not belong to you');
  return wallet;
}

function walletById({ params, userId }) {
  return reply(200, walletView(owned(wallets.get(Number(params.id)), userId, `Wallet ${params.id}`)));
}

function myWallet({ userId }) {
  const wallet = wallets.get(users.get(userId)?.walletId);
  return wallet ? reply(200, walletView(wallet)) : reply(404);
}

function walletOfUser({ params, userId }) {
  if (Number(params.userId) !== userId) return error(403, 'You can only view your own wallet');
  return myWallet({ userId });
}

function myBalance({ userId }) {
  const wallet = wallets.get(users.get(userId)?.walletId);
  return wallet
    ? reply(200, { balance: money(wallet.balance), currency: wallet.currency, walletId: wallet.walletId })
    : reply(200, { balance: 0, currency: 'ZAR', message: 'No wallet found' });
}

function transactions({ params, userId }) {
  const wallet = owned(wallets.get(Number(params.id)), userId, `Wallet ${params.id}`);
  const rows = history.filter(t => t.senderWalletId === wallet.walletId || t.recipientWalletId === wallet.walletId);
  return reply(200, rows.map(txView));
}

function reconcile({ params, userId }) {
  const wallet = owned(wallets.get(Number(params.id)), userId, `Wallet ${params.id}`);
  // The sandbox writes every balance through its ledger rows, so the two always agree.
  return reply(200, { walletId: wallet.walletId, cachedBalance: money(wallet.balance), ledgerBalance: money(wallet.balance), balanced: true });
}

// ---------------------------------------------------------------- money calls

function scopedKey(request, userId) {
  const key = request.headers.get('Idempotency-Key');
  if (!key || !key.trim()) throw new HttpError(400, 'Idempotency-Key header is required');
  if (key.length > 100) throw new HttpError(400, 'Idempotency-Key must be at most 100 characters');
  return `user:${userId}:${key}`;
}

const canonical = value => JSON.stringify(value, Object.keys(value).sort());

/** Runs a money operation once per key: same key and body replays, a different body is 409. */
function once(key, body, operation) {
  const seen = idempotency.get(key);
  const hash = canonical(body);
  if (seen) {
    if (seen.hash !== hash) throw new HttpError(409, `Idempotency-Key ${key} was already used for a different request`);
    return new Response(seen.text, { status: 200, headers: HEADERS }); // the first result, replayed
  }
  const text = toJson(operation());
  idempotency.set(key, { hash, text });
  return new Response(text, { status: 200, headers: HEADERS });
}

function amountOf(body) {
  if (body.amount === undefined || body.amount === null) throw new Error('amount missing'); // the service NPEs: 500
  const parsed = parseAmount(body.amount);
  if (parsed.error) throw new HttpError(400, parsed.error);
  return parsed;
}

function validate(parsed) {
  if (parsed.scaleTooBig) throw new HttpError(400, 'Amount cannot have more than two decimal places');
  if (parsed.cents <= 0) throw new HttpError(400, 'Amount must be greater than zero');
  return parsed.cents;
}

function record(type, sender, recipient, cents, description, user, before, after) {
  const row = { id: nextTxRow++, transactionId: uuid(), senderWalletId: sender, recipientWalletId: recipient, merchantId: null,
    amount: cents, transactionType: type, createdAt: now(), description, currency: 'ZAR', status: 'COMPLETED',
    balanceBefore: before, balanceAfter: after, userEmail: user.email, userPhone: user.phoneNumber };
  history.push(row);
  return { transactionId: row.transactionId, journalRef: row.transactionId, status: 'COMPLETED',
    amount: money(cents), balanceAfter: money(after) };
}

function topUp({ request, body, userId }) {
  const key = scopedKey(request, userId);
  const parsed = amountOf(body);
  if (body.walletAlias == null && body.walletId == null) throw new HttpError(400, 'Either walletAlias or walletId is required');
  return once(key, body, () => {
    const target = body.walletAlias != null ? walletByAlias(body.walletAlias) : wallets.get(Number(body.walletId));
    const wallet = owned(target, userId, 'Wallet');
    const cents = validate(parsed);
    const before = wallet.balance;
    wallet.balance += cents;
    wallet.version++;
    return record('DEPOSIT', null, wallet.walletId, cents, body.description ?? 'Top up', users.get(userId), before, wallet.balance);
  });
}

function transfer({ request, body, userId }) {
  const key = scopedKey(request, userId);
  const parsed = amountOf(body);
  return once(key, body, () => {
    const from = owned(walletByAlias(body.fromWalletAlias), userId, 'Source wallet');
    const to = walletByAlias(body.toWalletAlias);
    if (!to) throw new HttpError(404, `Destination wallet not found with alias: ${body.toWalletAlias}`);
    const cents = validate(parsed);
    if (from.walletId === to.walletId) throw new HttpError(400, 'Cannot transfer to the same wallet');
    if (from.balance < cents) throw new HttpError(422, `Insufficient balance in wallet ${from.walletId}`);
    const before = from.balance;
    from.balance -= cents; from.version++;
    to.balance += cents; to.version++;
    return record('TRANSFER', from.walletId, to.walletId, cents, body.description ?? 'Transfer', users.get(userId), before, from.balance);
  });
}

function withdraw({ request, body, params, userId }) {
  const parsed = amountOf(body);
  if (body.operation === 'ADD') throw new HttpError(403, 'Use top up to add funds');
  const key = scopedKey(request, userId);
  return once(key, body, () => {
    const wallet = owned(wallets.get(Number(params.id)), userId, `Wallet ${params.id}`);
    if (body.operation !== 'SUBTRACT') throw new HttpError(400, `operation must be ADD or SUBTRACT, was: ${body.operation ?? null}`);
    const cents = validate(parsed);
    if (wallet.balance < cents) throw new HttpError(422, `Insufficient balance in wallet ${wallet.walletId}`);
    const before = wallet.balance;
    wallet.balance -= cents; wallet.version++;
    return record('WITHDRAWAL', wallet.walletId, null, cents, body.description ?? 'Balance adjustment', users.get(userId), before, wallet.balance);
  });
}

// ---------------------------------------------------------------- fees (FeeCalculator)

function fee({ body }) {
  if (body.transactionType == null) throw new Error('switch on null'); // the service throws: 500
  const rate = { TRANSFER: 1, WITHDRAWAL: 2 }[body.transactionType];
  if (!rate) return reply(200, { fee: 0 });
  const parsed = amountOf(body);
  if (parsed.scaleTooBig) {
    // FeeCalculator multiplies, then rounds half-up to cents.
    const exact = Number(String(body.amount)) * rate / 100;
    return reply(200, { fee: money(Math.round(exact * 100)) });
  }
  return reply(200, { fee: money(Math.round(parsed.cents * rate / 100)) });
}
