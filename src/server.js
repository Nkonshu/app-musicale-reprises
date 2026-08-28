require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');

const { hashFile, recordConsent, getConsent, ATTESTATION_TEXT } = require('./consent');
const { registerUser, loginUser, registerAnonymous, linkAccount } = require('./auth');
const requireAuth = require('./middleware/requireAuth');
const requireAdmin = require('./middleware/requireAdmin');
const optionalAuth = require('./middleware/optionalAuth');
const requireConsent = require('./middleware/requireConsent');
const { transcribeAudioToMidi } = require('./pipeline/transcribe');
const { generateVariantFromAudio, generateFromPrompt } = require('./pipeline/generate');
const { downloadYoutubeAudio } = require('./pipeline/youtube');
const catalogue = require('./catalogue');
const karaoke = require('./karaoke');
const credits = require('./credits');
const creations = require('./creations');
const settings = require('./settings');
const leaderboard = require('./leaderboard');
const db = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({ dest: UPLOAD_DIR });

// --- Authentification ------------------------------------------------------
// Email + mot de passe, sessions par token opaque (table `sessions`, 30j).
// Remplace le champ `userId` texte libre non vérifié utilisé jusqu'ici sur
// /api/consent et la soumission catalogue.

app.post('/api/auth/register', (req, res) => {
  try {
    const { email, password, referralCode } = req.body;
    res.status(201).json(registerUser({ email, password, referralCode }));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/auth/login', (req, res) => {
  try {
    const { email, password } = req.body;
    res.json(loginUser({ email, password }));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Créée automatiquement au premier lancement de l'app, sans intervention de
// l'utilisateur — voir auth.js#registerAnonymous.
app.post('/api/auth/anonymous', (req, res) => {
  try {
    res.status(201).json(registerAnonymous());
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/auth/link', requireAuth, (req, res) => {
  try {
    const { email, password, referralCode } = req.body;
    res.json(linkAccount(req.user.id, { email, password, referralCode }));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json(req.user);
});

// --- Paramètres (écran 17) -------------------------------------------------

app.get('/api/me/settings', requireAuth, (req, res) => {
  res.json(settings.getSettings(req.user.id));
});

app.patch('/api/me/settings', requireAuth, (req, res) => {
  res.json(settings.updateSettings(req.user.id, req.body || {}));
});

app.patch('/api/me/profile', requireAuth, (req, res) => {
  const { displayName } = req.body;
  if (!displayName) return res.status(400).json({ error: 'displayName requis.' });
  db.prepare('UPDATE users SET displayName = ? WHERE id = ?').run(displayName, req.user.id);
  res.json({ ...req.user, displayName });
});

// --- Classement (écran 19) --------------------------------------------------
// Critère : nombre de reprises créées (table `creations`) — décision prise
// faute de spécification, voir leaderboard.js.

app.get('/api/leaderboard', (req, res) => {
  const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
  res.json(leaderboard.getLeaderboard(limit));
});

app.get('/api/leaderboard/me', requireAuth, (req, res) => {
  res.json(leaderboard.getUserRank(req.user.id));
});

// --- Parrainage (écran 18) --------------------------------------------------
// Le code de parrainage de l'utilisateur est déjà dans /api/auth/me
// (`referralCode`). Bonus attribués une seule fois par filleul (contrainte
// UNIQUE sur refereeId côté DB) — la double-attribution est un bug réel déjà
// rencontré sur un autre projet (Chap Chap), donc explicitement gardé contre.

app.get('/api/me/referrals', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.creditsAwarded, r.createdAt, u.email AS refereeEmail
    FROM referrals r JOIN users u ON u.id = r.refereeId
    WHERE r.referrerId = ?
    ORDER BY r.createdAt DESC
  `).all(req.user.id);
  res.json(rows);
});

// --- Mes reprises (écrans 11-13) -------------------------------------------
// Persistance des résultats (génération IA ou mix karaoké) au-delà du
// téléchargement immédiat — alimentée depuis les points de succès des
// pipelines ci-dessous, jamais créée directement par le client.

app.get('/api/me/creations', requireAuth, (req, res) => {
  res.json(creations.listCreations(req.user.id));
});

app.get('/api/me/creations/:id', requireAuth, (req, res) => {
  try {
    res.json(creations.getCreation(req.params.id, req.user.id));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/me/creations/:id/audio', requireAuth, (req, res) => {
  try {
    const creation = creations.getCreation(req.params.id, req.user.id);
    res.download(creation.resultFilePath);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.delete('/api/me/creations/:id', requireAuth, (req, res) => {
  try {
    creations.deleteCreation(req.params.id, req.user.id);
    res.status(204).end();
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// --- Consentement --------------------------------------------------------
// Étape obligatoire avant transcription ou génération sur un fichier donné.
// Reprend l'attestation déjà présente dans le design (écrans 14/15) : pas de
// vérification technique, juste un accord explicite et horodaté par fichier,
// désormais lié à un vrai compte (requireAuth) plutôt qu'à un userId déclaré.

app.get('/api/consent/text', (req, res) => {
  res.json({ text: ATTESTATION_TEXT });
});

app.post('/api/consent', requireAuth, upload.single('audio'), (req, res) => {
  try {
    const { accepted } = req.body;
    const fileHash = hashFile(req.file.path);
    const consent = recordConsent({
      fileHash,
      userId: req.user.id,
      accepted: accepted === 'true' || accepted === true,
    });
    res.json(consent);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    if (req.file) fs.unlink(req.file.path, () => {});
  }
});

// --- Transcription (audio -> MIDI) ---------------------------------------

app.post('/api/transcribe', requireAuth, upload.single('audio'), requireConsent, async (req, res) => {
  const workDir = path.join(UPLOAD_DIR, crypto.randomUUID());
  fs.mkdirSync(workDir, { recursive: true });
  try {
    const midiPath = await transcribeAudioToMidi(req.file.path, workDir);
    res.download(midiPath, 'transcribed.mid', (err) => {
      cleanup(workDir);
      if (req.file) fs.unlink(req.file.path, () => {});
      if (err) console.error('download error', err);
    });
  } catch (err) {
    cleanup(workDir);
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: err.message });
  }
});

// --- Génération de variante (audio et/ou texte -> audio) -------------------
// Trois combinaisons acceptées : audio+texte, texte seul, audio seul (voir
// generate.js). Pipeline avec audio : Demucs (Fal.ai) retire la voix de
// l'audio envoyé -> l'instrumental obtenu sert de référence à Stable Audio
// 2.5 (Fal.ai). Pipeline texte seul : Stable Audio 2.5 en mode text-to-audio
// direct, pas d'étape Demucs. Ni MiniMax (durée non déterministe) ni
// MusicGen (conditionnement mélodique trop faible) n'ont été gardés.
// `durationSeconds` est optionnel : si absent, la sortie correspond par
// défaut à la longueur de l'audio fourni (comportement natif du modèle) ou à
// la valeur par défaut du modèle en mode texte seul.
// Crédits vérifiés AVANT de lancer le pipeline (jamais d'appel payant si
// solde insuffisant), débités APRÈS succès seulement (un échec fournisseur
// ne doit pas coûter de crédits à l'utilisateur). Le consentement (fichier
// utilisateur) n'est requis que si un fichier a réellement été envoyé — rien
// à consentir sur du texte seul.
app.post('/api/generate-variant', requireAuth, upload.single('audio'), async (req, res) => {
  const { prompt, durationSeconds, strength } = req.body;
  if (!req.file && !(prompt && prompt.trim())) {
    return res.status(400).json({ error: "Fournis un fichier audio de référence et/ou un texte de style." });
  }
  if (req.file) {
    const fileHash = hashFile(req.file.path);
    const consent = getConsent(fileHash);
    if (!consent || !consent.accepted) {
      fs.unlink(req.file.path, () => {});
      return res.status(403).json({
        error: "Consentement requis avant de traiter ce fichier.",
        fileHash,
        hint: "Appelle POST /api/consent avec ce fileHash et accepted:true au préalable.",
      });
    }
  }
  try {
    credits.checkBalance(req.user.id, 'generateVariant');
  } catch (err) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(err.status || 500).json({ error: err.message });
  }
  const workDir = path.join(UPLOAD_DIR, crypto.randomUUID());
  fs.mkdirSync(workDir, { recursive: true });
  try {
    const genOptions = {
      prompt,
      durationSeconds: durationSeconds ? parseInt(durationSeconds, 10) : undefined,
      strength: strength ? parseFloat(strength) : undefined,
    };
    const variantPath = req.file
      ? await generateVariantFromAudio(req.file.path, workDir, genOptions)
      : await generateFromPrompt(workDir, genOptions);
    credits.consume(req.user.id, 'generateVariant');
    const creation = creations.recordCreation({ userId: req.user.id, type: 'ai_generation_upload', prompt, resultFilePath: variantPath });
    res.set('X-Creation-Id', creation.id);
    res.download(variantPath, 'variant.wav', (err) => {
      cleanup(workDir);
      if (req.file) fs.unlink(req.file.path, () => {});
      if (err) console.error('download error', err);
    });
  } catch (err) {
    cleanup(workDir);
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: err.message });
  }
});

// --- Import YouTube ---------------------------------------------------
// Verrou admin retiré à la demande — accessible à tout compte authentifié
// (y compris une session anonyme, créée automatiquement pour chaque
// utilisateur). Récupère l'audio d'un lien YouTube pour l'utiliser comme
// référence de style. Renvoie le fichier tel quel — pas d'appel au pipeline
// de génération ici, le client le traite ensuite exactement comme un
// fichier importé normal (même passage obligé par /api/consent puis
// /api/generate-variant, aucun raccourci de droits).
app.post('/api/admin/youtube-audio', requireAuth, upload.none(), async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url requise.' });
  const workDir = path.join(UPLOAD_DIR, crypto.randomUUID());
  fs.mkdirSync(workDir, { recursive: true });
  try {
    const { path: audioPath, title } = await downloadYoutubeAudio(url, workDir);
    if (title) res.set('X-Youtube-Title', encodeURIComponent(title));
    res.download(audioPath, 'youtube-audio.mp3', (err) => {
      cleanup(workDir);
      if (err) console.error('download error', err);
    });
  } catch (err) {
    cleanup(workDir);
    res.status(500).json({ error: `Échec du téléchargement YouTube : ${err.message}` });
  }
});

// --- Catalogue (écrans 3-5, 15) -------------------------------------------
// Un morceau du catalogue n'est éligible à "Génération IA" (écran 8) que s'il
// est passé par une soumission artiste avec cession de droits (rightsCeded) —
// c'est ce qui distingue ce chemin de l'upload personnel ci-dessus, qui lui
// nécessite un consentement par appel plutôt qu'un droit cédé une fois pour
// toutes sur le morceau. La soumission et la génération depuis le catalogue
// exigent désormais un compte (requireAuth) ; parcourir le catalogue reste
// public (écrans 3-5 sont accessibles avant connexion).

app.post('/api/catalogue/submit', requireAuth, upload.single('audio'), (req, res) => {
  try {
    const { title, artistName, genre, rightsCeded } = req.body;
    const track = catalogue.submitTrack({
      title,
      artistName,
      genre,
      rightsCeded: rightsCeded === 'true' || rightsCeded === true,
      uploadedFilePath: req.file.path,
      submitterId: req.user.id,
    });
    res.status(201).json(track);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    if (req.file) fs.unlink(req.file.path, () => {});
  }
});

app.get('/api/catalogue', optionalAuth, (req, res) => {
  const { search, genre, status } = req.query;
  // Un statut autre que "approved" (la valeur publique par défaut) n'est
  // consultable que par un admin — sinon n'importe qui pouvait lister les
  // soumissions en attente via ?status=pending sans être authentifié.
  const isAdmin = req.user && req.user.role === 'admin';
  const effectiveStatus = status && status !== 'approved' && !isAdmin ? 'approved' : status;
  res.json(catalogue.listTracks({ search, genre, status: effectiveStatus }));
});

app.get('/api/catalogue/:id', (req, res) => {
  const track = catalogue.getTrack(req.params.id);
  if (!track) return res.status(404).json({ error: 'Morceau introuvable.' });
  res.json(track);
});

// Aperçu audio d'un morceau du catalogue (bouton lecture, écran 5) — public
// comme le reste de la navigation catalogue, pas de compte requis.
app.get('/api/catalogue/:id/audio', (req, res) => {
  const track = catalogue.getTrack(req.params.id);
  if (!track) return res.status(404).json({ error: 'Morceau introuvable.' });
  res.download(track.audioFilePath, path.basename(track.audioFilePath));
});

// Modération désormais réservée aux comptes admin (voir requireAdmin.js et
// ADMIN_EMAILS dans .env) — comble le trou de sécurité laissé par la
// première version de cette route.
app.post('/api/catalogue/:id/approve', requireAuth, requireAdmin, (req, res) => {
  const track = catalogue.getTrack(req.params.id);
  if (!track) return res.status(404).json({ error: 'Morceau introuvable.' });
  res.json(catalogue.approveTrack(req.params.id));
});

app.post('/api/catalogue/:id/generate-variant', requireAuth, upload.none(), async (req, res) => {
  const track = catalogue.getTrack(req.params.id);
  if (!track) return res.status(404).json({ error: 'Morceau introuvable.' });
  if (track.status !== 'approved') {
    return res.status(403).json({ error: "Ce morceau n'est pas encore approuvé pour la génération IA." });
  }
  try {
    credits.checkBalance(req.user.id, 'generateVariant');
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
  const { prompt, durationSeconds, strength } = req.body;
  const workDir = path.join(UPLOAD_DIR, crypto.randomUUID());
  fs.mkdirSync(workDir, { recursive: true });
  try {
    const variantPath = await generateVariantFromAudio(track.audioFilePath, workDir, {
      prompt,
      durationSeconds: durationSeconds ? parseInt(durationSeconds, 10) : undefined,
      strength: strength ? parseFloat(strength) : undefined,
    });
    credits.consume(req.user.id, 'generateVariant');
    const creation = creations.recordCreation({
      userId: req.user.id, type: 'ai_generation_catalogue', sourceTrackId: track.id, prompt, resultFilePath: variantPath,
    });
    res.set('X-Creation-Id', creation.id);
    res.download(variantPath, 'variant.wav', (err) => {
      cleanup(workDir);
      if (err) console.error('download error', err);
    });
  } catch (err) {
    cleanup(workDir);
    res.status(500).json({ error: err.message });
  }
});

// --- Karaoké (écrans 6-7, 9, 10) -------------------------------------------
// Écran 9 : POST .../autotune calcule la version corrigée (Parselmouth/Praat,
// scripts/autotune.py) sans écraser l'original — .../vocal-raw et
// .../vocal-tuned servent la comparaison avant/après que montre cet écran.

// `trackId` (morceau du catalogue) ou `creationId` (création IA personnelle,
// voir karaoke.js#createSessionFromCreation) — jamais les deux.
app.post('/api/karaoke/sessions', requireAuth, upload.none(), async (req, res) => {
  try {
    credits.checkBalance(req.user.id, 'karaokeSession');
    const session = req.body.creationId
      ? await karaoke.createSessionFromCreation({ userId: req.user.id, creationId: req.body.creationId })
      : await karaoke.createSession({ userId: req.user.id, trackId: req.body.trackId });
    credits.consume(req.user.id, 'karaokeSession');
    res.status(201).json(session);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/karaoke/sessions/:id', requireAuth, (req, res) => {
  try {
    res.json(karaoke.getSession(req.params.id, req.user.id));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/karaoke/sessions/:id/backing', requireAuth, (req, res) => {
  try {
    const session = karaoke.getSession(req.params.id, req.user.id);
    res.download(session.backingTrackPath, 'backing.wav');
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/karaoke/sessions/:id/vocal', requireAuth, upload.single('audio'), async (req, res) => {
  try {
    const session = await karaoke.addVocalTake(req.params.id, req.user.id, req.file.path);
    res.json(session);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    if (req.file) fs.unlink(req.file.path, () => {});
  }
});

app.post('/api/karaoke/sessions/:id/autotune', requireAuth, upload.none(), async (req, res) => {
  try {
    const { correctionStrength } = req.body;
    const session = await karaoke.applyAutotune(
      req.params.id, req.user.id, correctionStrength !== undefined ? parseFloat(correctionStrength) : undefined
    );
    res.json(session);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/karaoke/sessions/:id/vocal-raw', requireAuth, (req, res) => {
  try {
    const session = karaoke.getSession(req.params.id, req.user.id);
    if (!session.vocalTakePath) return res.status(404).json({ error: 'Pas de prise vocale.' });
    res.download(session.vocalTakePath, 'vocal_raw.wav');
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/karaoke/sessions/:id/vocal-tuned', requireAuth, (req, res) => {
  try {
    const session = karaoke.getSession(req.params.id, req.user.id);
    if (!session.tunedVocalPath) return res.status(404).json({ error: 'Autotune pas encore appliqué.' });
    res.download(session.tunedVocalPath, 'vocal_tuned.wav');
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/karaoke/sessions/:id/mix', requireAuth, upload.none(), async (req, res) => {
  try {
    const session = await karaoke.mixFinal(req.params.id, req.user.id);
    creations.recordCreation({
      userId: req.user.id, type: 'karaoke', sourceTrackId: session.trackId, resultFilePath: session.finalMixPath,
    });
    res.download(session.finalMixPath, 'final.wav');
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

function cleanup(dir) {
  fs.rm(dir, { recursive: true, force: true }, () => {});
}

const port = process.env.PORT || 3300;
app.listen(port, () => console.log(`app-musicale-reprises API sur http://localhost:${port}`));
