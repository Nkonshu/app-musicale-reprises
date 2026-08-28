const crypto = require('crypto');
const db = require('./db');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours
const REFERRAL_BONUS_REFERRER = parseInt(process.env.REFERRAL_BONUS_REFERRER, 10) || 50;
const REFERRAL_BONUS_REFEREE = parseInt(process.env.REFERRAL_BONUS_REFEREE, 10) || 20;
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  throw err;
}

function generateReferralCode() {
  // Retry-on-collision is essentially theoretical at this table size, but
  // cheap to guard against since referralCode is UNIQUE.
  for (let i = 0; i < 5; i++) {
    const code = crypto.randomBytes(4).toString('hex');
    if (!db.prepare('SELECT 1 FROM users WHERE referralCode = ?').get(code)) return code;
  }
  throw new Error('Impossible de générer un code de parrainage unique.');
}

function registerUser({ email, password, referralCode }) {
  if (!email || !password) badRequest('email et password sont requis.');
  if (password.length < 8) badRequest('Le mot de passe doit faire au moins 8 caractères.');

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    const err = new Error('Un compte existe déjà avec cet email.');
    err.status = 409;
    throw err;
  }

  let referrer = null;
  if (referralCode) {
    referrer = db.prepare('SELECT id FROM users WHERE referralCode = ?').get(referralCode);
    if (!referrer) badRequest('Code de parrainage invalide.');
  }

  const id = crypto.randomUUID();
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPassword(password, salt);
  const role = ADMIN_EMAILS.includes(email.toLowerCase()) ? 'admin' : 'user';
  const myReferralCode = generateReferralCode();
  const startingCredits = 100 + (referrer ? REFERRAL_BONUS_REFEREE : 0);

  db.prepare(`
    INSERT INTO users (id, email, passwordHash, passwordSalt, role, credits, referralCode, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, email, passwordHash, salt, role, startingCredits, myReferralCode, new Date().toISOString());

  if (referrer) {
    db.prepare(`
      INSERT INTO referrals (id, referrerId, refereeId, creditsAwarded, createdAt)
      VALUES (?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), referrer.id, id, REFERRAL_BONUS_REFERRER, new Date().toISOString());
    db.prepare('UPDATE users SET credits = credits + ? WHERE id = ?').run(REFERRAL_BONUS_REFERRER, referrer.id);
  }

  return createSession(id);
}

// Session créée silencieusement au premier lancement de l'app, sans email ni
// mot de passe — l'utilisateur a un compte (crédits, reprises) tout de suite,
// mais ce compte n'est récupérable que depuis cet appareil tant qu'il n'est
// pas rattaché à un email via linkAccount ci-dessous.
function registerAnonymous() {
  const id = crypto.randomUUID();
  const myReferralCode = generateReferralCode();
  db.prepare(`
    INSERT INTO users (id, role, credits, referralCode, createdAt)
    VALUES (?, 'user', 100, ?, ?)
  `).run(id, myReferralCode, new Date().toISOString());
  return createSession(id);
}

// Attache un email/mot de passe au compte anonyme déjà utilisé (même id,
// même token, mêmes crédits/reprises déjà accumulés) plutôt que de créer un
// nouveau compte vide — c'est ce qui rend la sauvegarde possible sans perdre
// le travail fait avant la connexion.
function linkAccount(userId, { email, password, referralCode }) {
  if (!email || !password) badRequest('email et password sont requis.');
  if (password.length < 8) badRequest('Le mot de passe doit faire au moins 8 caractères.');

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) badRequest('Compte introuvable.');
  if (user.email) {
    const err = new Error('Ce compte est déjà relié à un email.');
    err.status = 409;
    throw err;
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    const err = new Error('Un compte existe déjà avec cet email.');
    err.status = 409;
    throw err;
  }

  let referrer = null;
  if (referralCode) {
    referrer = db.prepare('SELECT id FROM users WHERE referralCode = ?').get(referralCode);
    if (!referrer) badRequest('Code de parrainage invalide.');
    if (referrer.id === userId) badRequest('Tu ne peux pas utiliser ton propre code.');
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPassword(password, salt);
  db.prepare('UPDATE users SET email = ?, passwordHash = ?, passwordSalt = ? WHERE id = ?')
    .run(email, passwordHash, salt, userId);

  if (referrer) {
    db.prepare(`
      INSERT INTO referrals (id, referrerId, refereeId, creditsAwarded, createdAt)
      VALUES (?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), referrer.id, userId, REFERRAL_BONUS_REFERRER, new Date().toISOString());
    db.prepare('UPDATE users SET credits = credits + ? WHERE id = ?').run(REFERRAL_BONUS_REFERRER, referrer.id);
    db.prepare('UPDATE users SET credits = credits + ? WHERE id = ?').run(REFERRAL_BONUS_REFEREE, userId);
  }

  return db.prepare(`SELECT ${PUBLIC_USER_FIELDS} FROM users WHERE id = ?`).get(userId);
}

function loginUser({ email, password }) {
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const invalid = () => {
    const err = new Error('Email ou mot de passe incorrect.');
    err.status = 401;
    throw err;
  };
  if (!user) invalid();

  const computedHash = hashPassword(password, user.passwordSalt);
  const expected = Buffer.from(user.passwordHash, 'hex');
  const actual = Buffer.from(computedHash, 'hex');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) invalid();

  return createSession(user.id);
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  db.prepare(`
    INSERT INTO sessions (token, userId, createdAt, expiresAt)
    VALUES (?, ?, ?, ?)
  `).run(token, userId, now.toISOString(), expiresAt.toISOString());
  return { token, expiresAt: expiresAt.toISOString() };
}

const PUBLIC_USER_FIELDS = 'id, email, role, credits, settingsJson, referralCode, createdAt';

function getUserByToken(token) {
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!session) return null;
  if (new Date(session.expiresAt) < new Date()) return null;
  const user = db.prepare(`SELECT ${PUBLIC_USER_FIELDS} FROM users WHERE id = ?`).get(session.userId);
  return user || null;
}

module.exports = { registerUser, loginUser, registerAnonymous, linkAccount, getUserByToken, PUBLIC_USER_FIELDS };
