const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const { hashFile } = require('./consent');

const AUDIO_DIR = path.join(__dirname, '..', 'catalogue-audio');
fs.mkdirSync(AUDIO_DIR, { recursive: true });

// Écran 15 "Soumission artiste" — an artist submits a track and explicitly
// cedes usage rights for it. This is what makes a track eligible for the
// "Génération IA" flow (écran 8): consent lives on the CATALOGUE ENTRY,
// given once at submission time by the rights holder, not per end-user
// generation request like the personal-upload path (consent.js) requires.
function submitTrack({ title, artistName, genre, rightsCeded, uploadedFilePath, submitterId }) {
  if (!rightsCeded) {
    const err = new Error("La cession des droits d'usage est obligatoire pour soumettre un morceau.");
    err.status = 422;
    throw err;
  }
  if (!title || !artistName) {
    const err = new Error('title et artistName sont requis.');
    err.status = 400;
    throw err;
  }

  const id = crypto.randomUUID();
  const ext = path.extname(uploadedFilePath) || '.mp3';
  const storedPath = path.join(AUDIO_DIR, `${id}${ext}`);
  fs.copyFileSync(uploadedFilePath, storedPath);
  const audioFileHash = hashFile(storedPath);

  db.prepare(`
    INSERT INTO tracks (id, title, artistName, genre, audioFilePath, audioFileHash, rightsCeded, status, submitterId, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, 1, 'pending', ?, ?)
  `).run(id, title, artistName, genre || null, storedPath, audioFileHash, submitterId, new Date().toISOString());

  return getTrack(id);
}

function listTracks({ status = 'approved', search, genre } = {}) {
  let sql = 'SELECT * FROM tracks WHERE status = ?';
  const params = [status];
  if (genre) {
    sql += ' AND genre = ?';
    params.push(genre);
  }
  if (search) {
    sql += ' AND (title LIKE ? OR artistName LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  sql += ' ORDER BY createdAt DESC';
  return db.prepare(sql).all(...params);
}

function getTrack(id) {
  return db.prepare('SELECT * FROM tracks WHERE id = ?').get(id) || null;
}

function approveTrack(id) {
  db.prepare("UPDATE tracks SET status = 'approved' WHERE id = ?").run(id);
  return getTrack(id);
}

// Cache la transcription mélodique (voir karaoke.js) sur le morceau plutôt
// que sur chaque session karaoké : plusieurs utilisateurs peuvent chanter le
// même morceau, la transcription n'a besoin d'être calculée qu'une fois.
function setMelodyPath(id, melodyMidiPath) {
  db.prepare('UPDATE tracks SET melodyMidiPath = ? WHERE id = ?').run(melodyMidiPath, id);
  return getTrack(id);
}

module.exports = { submitTrack, listTracks, getTrack, approveTrack, setMelodyPath };
