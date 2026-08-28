const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STORE_PATH = path.join(__dirname, '..', 'data', 'consents.json');

const ATTESTATION_TEXT =
  "Je certifie être l'auteur ou l'ayant-droit de ce fichier audio, ou disposer " +
  "des droits nécessaires pour le traiter avec les outils IA de l'application " +
  "(transcription, génération de variante).";

function loadStore() {
  if (!fs.existsSync(STORE_PATH)) return {};
  return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
}

function saveStore(store) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

function hashFile(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function recordConsent({ fileHash, userId, accepted }) {
  if (!accepted) {
    const err = new Error('Consentement refusé ou manquant.');
    err.status = 422;
    throw err;
  }
  const store = loadStore();
  const consentId = crypto.randomUUID();
  store[fileHash] = {
    consentId,
    fileHash,
    userId: userId || null,
    accepted: true,
    text: ATTESTATION_TEXT,
    createdAt: new Date().toISOString(),
  };
  saveStore(store);
  return store[fileHash];
}

function getConsent(fileHash) {
  const store = loadStore();
  return store[fileHash] || null;
}

module.exports = { ATTESTATION_TEXT, hashFile, recordConsent, getConsent };
