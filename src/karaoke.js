const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const db = require('./db');
const { getTrack, setMelodyPath } = require('./catalogue');
const { getCreation } = require('./creations');
const { separateStems } = require('./pipeline/separate');
const { transcribeAudioToMidi } = require('./pipeline/transcribe');

const STORAGE_DIR = path.join(__dirname, '..', 'karaoke-sessions');
fs.mkdirSync(STORAGE_DIR, { recursive: true });

const MELODY_DIR = path.join(__dirname, '..', 'melody-cache');
fs.mkdirSync(MELODY_DIR, { recursive: true });

const PYTHON_BIN = 'C:/Users/nkons/AppData/Local/Programs/Python/Python312/python.exe';
const AUTOTUNE_SCRIPT = path.join(__dirname, '..', 'scripts', 'autotune.py');

function sessionDir(id) {
  const dir = path.join(STORAGE_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function notFound(message) {
  const err = new Error(message);
  err.status = 404;
  throw err;
}
function forbidden(message) {
  const err = new Error(message);
  err.status = 403;
  throw err;
}

// Transcrit la voix isolée (stem Demucs) du morceau catalogue en MIDI, pour
// servir de cible mélodique réelle à l'autotune (écran 9 v2) plutôt que de
// se contenter d'une correction chromatique générique. Mis en cache sur le
// morceau (tracks.melodyMidiPath) : plusieurs sessions karaoké sur le même
// morceau réutilisent la même transcription au lieu de la refaire.
async function ensureMelodyReference(track, vocalsStemPath) {
  if (track.melodyMidiPath && fs.existsSync(track.melodyMidiPath)) return track.melodyMidiPath;
  if (!vocalsStemPath) return null;

  const tmpWorkDir = path.join(MELODY_DIR, `tmp-${crypto.randomUUID()}`);
  fs.mkdirSync(tmpWorkDir, { recursive: true });
  try {
    const midiPath = await transcribeAudioToMidi(vocalsStemPath, tmpWorkDir);
    const storedPath = path.join(MELODY_DIR, `${track.id}.mid`);
    fs.copyFileSync(midiPath, storedPath);
    setMelodyPath(track.id, storedPath);
    return storedPath;
  } catch (err) {
    // La transcription mélodique est un bonus, pas un pré-requis : si elle
    // échoue (ex. voix trop faible dans le stem), l'autotune retombe sur la
    // correction chromatique générique plutôt que de bloquer toute la session.
    console.error('ensureMelodyReference failed (non-blocking):', err.message);
    return null;
  } finally {
    fs.rmSync(tmpWorkDir, { recursive: true, force: true });
  }
}

// Écran 6 "Config avant enregistrement" — prépare la piste d'accompagnement
// (voix retirée du morceau catalogue via Demucs) et, en tâche de fond,
// la référence mélodique pour l'autotune (voir ensureMelodyReference).
async function createSession({ userId, trackId }) {
  const track = getTrack(trackId);
  if (!track) notFound('Morceau introuvable.');
  if (track.status !== 'approved') forbidden("Ce morceau n'est pas disponible pour le karaoké.");

  const id = crypto.randomUUID();
  const dir = sessionDir(id);
  const tmpWorkDir = path.join(dir, 'tmp');
  fs.mkdirSync(tmpWorkDir, { recursive: true });

  const { instrumentalPath, vocalsPath } = await separateStems(track.audioFilePath, tmpWorkDir);
  const backingTrackPath = path.join(dir, 'backing.wav');
  fs.copyFileSync(instrumentalPath, backingTrackPath);

  await ensureMelodyReference(track, vocalsPath);
  fs.rmSync(tmpWorkDir, { recursive: true, force: true });

  db.prepare(`
    INSERT INTO karaoke_sessions (id, userId, trackId, backingTrackPath, status, createdAt)
    VALUES (?, ?, ?, ?, 'backing_ready', ?)
  `).run(id, userId, trackId, backingTrackPath, new Date().toISOString());

  return getSession(id, userId);
}

// Variante de l'écran 6 quand la référence est une création IA personnelle
// (voir écran 8 "Génération IA") plutôt qu'un morceau du catalogue — atteint
// depuis "Chanter par-dessus" sur l'écran Résultat ou Détail création. Le
// résultat de Stable Audio 2.5 est déjà un instrumental : contrairement à
// createSession ci-dessus, pas de séparation Demucs à faire, et pas de
// référence mélodique (il n'existe pas de "voix d'origine" pour ce morceau
// qui vient d'être généré) — l'autotune retombera sur la correction
// chromatique générique.
function createSessionFromCreation({ userId, creationId }) {
  const creation = getCreation(creationId, userId);

  const id = crypto.randomUUID();
  const dir = sessionDir(id);
  const backingTrackPath = path.join(dir, 'backing.wav');
  fs.copyFileSync(creation.resultFilePath, backingTrackPath);

  db.prepare(`
    INSERT INTO karaoke_sessions (id, userId, creationId, backingTrackPath, status, createdAt)
    VALUES (?, ?, ?, ?, 'backing_ready', ?)
  `).run(id, userId, creationId, backingTrackPath, new Date().toISOString());

  return getSession(id, userId);
}

// Écran 7 "Enregistrement" — l'utilisateur envoie sa prise vocale, enregistrée
// en écoutant la piste d'accompagnement (côté client, hors backend). Passe
// par ffmpeg plutôt qu'une simple copie : un enregistreur navigateur (API
// MediaRecorder) produit du webm/opus, pas du wav — sans cette conversion,
// le fichier serait mal formé (extension .wav sur un contenu qui n'en est
// pas), ce qui casse Parselmouth (autotune) même si ffmpeg tolère souvent
// un contenu mal étiqueté par sniffing.
function addVocalTake(id, userId, uploadedFilePath) {
  const session = getSession(id, userId);
  const dir = sessionDir(id);
  const vocalTakePath = path.join(dir, 'vocal.wav');

  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, ['-y', '-i', uploadedFilePath, '-ac', '1', '-ar', '44100', vocalTakePath], (err) => {
      if (err) return reject(err);
      db.prepare(`UPDATE karaoke_sessions SET vocalTakePath = ?, status = 'vocal_recorded' WHERE id = ?`)
        .run(vocalTakePath, id);
      resolve(getSession(id, userId));
    });
  });
}

// Écran 9 "Comparaison autotune" — correction de hauteur (Praat/Parselmouth,
// PSOLA, scripts/autotune.py). Si le morceau a une référence mélodique
// (ensureMelodyReference), corrige vers la note ACTIVE de la mélodie
// d'origine à chaque instant (en supposant l'enregistrement synchronisé sur
// le début de la piste d'accompagnement — hypothèse raisonnable pour un
// karaoké) ; sinon, retombe sur la correction chromatique générique (v1).
// correctionStrength : 1.0 = collé sur la cible (effet robotique), 0.0 =
// inchangé. Résultat stocké séparément (tunedVocalPath) : l'original reste
// disponible pour comparer avant/après.
function applyAutotune(id, userId, correctionStrength = 1.0) {
  const session = getSession(id, userId);
  if (!session.vocalTakePath) {
    const err = new Error("Aucune prise vocale enregistrée pour cette session.");
    err.status = 400;
    throw err;
  }
  const track = session.trackId ? getTrack(session.trackId) : null;
  const dir = sessionDir(id);
  const tunedVocalPath = path.join(dir, 'vocal_tuned.wav');

  const args = [AUTOTUNE_SCRIPT, session.vocalTakePath, tunedVocalPath, String(correctionStrength)];
  if (track?.melodyMidiPath && fs.existsSync(track.melodyMidiPath)) {
    args.push(track.melodyMidiPath);
  }

  return new Promise((resolve, reject) => {
    execFile(PYTHON_BIN, args, (err, stdout, stderr) => {
      if (err) return reject(new Error(`autotune failed: ${stderr || err.message}`));
      db.prepare(`UPDATE karaoke_sessions SET tunedVocalPath = ?, status = 'vocal_tuned' WHERE id = ?`)
        .run(tunedVocalPath, id);
      resolve(getSession(id, userId));
    });
  });
}

// Écran 10 "Assemblage final" — mixe la piste d'accompagnement avec la prise
// vocale autotunée si elle existe (l'utilisateur est passé par l'écran 9),
// sinon la prise brute (l'autotune reste optionnelle, pas imposée).
function mixFinal(id, userId) {
  const session = getSession(id, userId);
  if (!session.vocalTakePath) {
    const err = new Error("Aucune prise vocale enregistrée pour cette session.");
    err.status = 400;
    throw err;
  }
  const dir = sessionDir(id);
  const finalMixPath = path.join(dir, 'final.wav');
  const vocalToMix = session.tunedVocalPath || session.vocalTakePath;

  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, [
      '-y',
      '-i', session.backingTrackPath,
      '-i', vocalToMix,
      '-filter_complex', 'amix=inputs=2:duration=longest:normalize=0',
      '-ar', '44100', finalMixPath,
    ], (err, stdout, stderr) => {
      // stderr était ignoré ici (contrairement à applyAutotune) : un vrai
      // échec ffmpeg remontait comme "Command failed" générique côté client,
      // sans le diagnostic utile.
      if (err) return reject(new Error(`mix failed: ${stderr || err.message}`));
      db.prepare(`UPDATE karaoke_sessions SET finalMixPath = ?, status = 'completed' WHERE id = ?`)
        .run(finalMixPath, id);
      resolve(getSession(id, userId));
    });
  });
}

function getSession(id, userId) {
  const session = db.prepare('SELECT * FROM karaoke_sessions WHERE id = ?').get(id);
  if (!session) notFound('Session karaoké introuvable.');
  if (session.userId !== userId) forbidden("Cette session ne t'appartient pas.");
  return session;
}

module.exports = { createSession, createSessionFromCreation, addVocalTake, applyAutotune, mixFinal, getSession };
