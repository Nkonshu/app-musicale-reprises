const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const STORAGE_DIR = path.join(__dirname, '..', 'creations-storage');
fs.mkdirSync(STORAGE_DIR, { recursive: true });

function notFound() {
  const err = new Error('Création introuvable.');
  err.status = 404;
  throw err;
}
function forbidden() {
  const err = new Error("Cette création ne t'appartient pas.");
  err.status = 403;
  throw err;
}

// Écrans 11-13 "Mes reprises" — persiste un résultat (génération IA ou mix
// karaoké terminé) pour qu'il survive au-delà du téléchargement immédiat.
// Appelé depuis les points de succès des pipelines existants, pas depuis
// une route dédiée : une création est toujours la conséquence d'une autre
// action, jamais créée directement par le client.
function recordCreation({ userId, type, sourceTrackId, prompt, resultFilePath }) {
  const id = crypto.randomUUID();
  const ext = path.extname(resultFilePath) || '.wav';
  const storedPath = path.join(STORAGE_DIR, `${id}${ext}`);
  fs.copyFileSync(resultFilePath, storedPath);

  db.prepare(`
    INSERT INTO creations (id, userId, type, sourceTrackId, prompt, resultFilePath, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, type, sourceTrackId || null, prompt || null, storedPath, new Date().toISOString());

  return getCreation(id, userId);
}

function listCreations(userId) {
  return db.prepare(`
    SELECT c.*, t.title AS trackTitle, t.artistName AS trackArtist
    FROM creations c
    LEFT JOIN tracks t ON t.id = c.sourceTrackId
    WHERE c.userId = ?
    ORDER BY c.createdAt DESC
  `).all(userId);
}

function getCreation(id, userId) {
  const creation = db.prepare(`
    SELECT c.*, t.title AS trackTitle, t.artistName AS trackArtist
    FROM creations c
    LEFT JOIN tracks t ON t.id = c.sourceTrackId
    WHERE c.id = ?
  `).get(id);
  if (!creation) notFound();
  if (creation.userId !== userId) forbidden();
  return creation;
}

function deleteCreation(id, userId) {
  const creation = getCreation(id, userId);
  fs.unlink(creation.resultFilePath, () => {});
  db.prepare('DELETE FROM creations WHERE id = ?').run(id);
}

module.exports = { recordCreation, listCreations, getCreation, deleteCreation };
