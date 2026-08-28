const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = path.join(__dirname, '..', 'data', 'catalogue.sqlite');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE,
    passwordHash TEXT,
    passwordSalt TEXT,
    role TEXT NOT NULL DEFAULT 'user',
    credits INTEGER NOT NULL DEFAULT 100,
    settingsJson TEXT NOT NULL DEFAULT '{}',
    referralCode TEXT NOT NULL UNIQUE,
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    userId TEXT NOT NULL REFERENCES users(id),
    createdAt TEXT NOT NULL,
    expiresAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tracks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    artistName TEXT NOT NULL,
    genre TEXT,
    audioFilePath TEXT NOT NULL,
    audioFileHash TEXT NOT NULL,
    rightsCeded INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    submitterId TEXT REFERENCES users(id),
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS karaoke_sessions (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL REFERENCES users(id),
    trackId TEXT REFERENCES tracks(id),
    backingTrackPath TEXT NOT NULL,
    vocalTakePath TEXT,
    tunedVocalPath TEXT,
    finalMixPath TEXT,
    status TEXT NOT NULL DEFAULT 'backing_ready',
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS creations (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL REFERENCES users(id),
    type TEXT NOT NULL,
    sourceTrackId TEXT REFERENCES tracks(id),
    prompt TEXT,
    resultFilePath TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS referrals (
    id TEXT PRIMARY KEY,
    referrerId TEXT NOT NULL REFERENCES users(id),
    refereeId TEXT NOT NULL UNIQUE REFERENCES users(id),
    creditsAwarded INTEGER NOT NULL,
    createdAt TEXT NOT NULL
  );
`);

// `email`/`passwordHash`/`passwordSalt` sont passés de NOT NULL à nullable
// (comptes anonymes, voir auth.js#registerAnonymous). SQLite ne sait pas
// modifier une contrainte de colonne existante : on reconstruit la table en
// préservant les lignes déjà présentes, plutôt qu'un DROP destructif.
function migrateUsersNullable() {
  const cols = db.prepare('PRAGMA table_info(users)').all();
  const emailCol = cols.find((c) => c.name === 'email');
  if (!emailCol || !emailCol.notnull) return;

  const existingNames = cols.map((c) => c.name);
  const knownCols = ['id', 'email', 'passwordHash', 'passwordSalt', 'role', 'credits', 'settingsJson', 'referralCode', 'displayName', 'createdAt'];
  const copyCols = knownCols.filter((c) => existingNames.includes(c)).join(', ');

  // FK OFF le temps de la reconstruction : sessions/tracks/karaoke_sessions/
  // creations/referrals référencent users(id), et SQLite refuse de DROP une
  // table encore référencée. On construit "users_new" (que personne ne
  // référence encore) puis on la renomme en "users" en dernier — les
  // définitions FK des autres tables, jamais renommées elles-mêmes,
  // continuent de désigner "users" et se retrouvent donc valides sans rien
  // avoir à réécrire.
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec(`
    CREATE TABLE users_new (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE,
      passwordHash TEXT,
      passwordSalt TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      credits INTEGER NOT NULL DEFAULT 100,
      settingsJson TEXT NOT NULL DEFAULT '{}',
      referralCode TEXT NOT NULL UNIQUE,
      displayName TEXT,
      createdAt TEXT NOT NULL
    );
    INSERT INTO users_new (${copyCols}) SELECT ${copyCols} FROM users;
    DROP TABLE users;
    ALTER TABLE users_new RENAME TO users;
  `);
  db.exec('PRAGMA foreign_keys = ON;');
}
migrateUsersNullable();

// `trackId` passe de NOT NULL à nullable (une session karaoké peut désormais
// partir d'une création IA personnelle via `creationId` plutôt que d'un
// morceau du catalogue — voir karaoke.js#createSessionFromCreation). Même
// technique de reconstruction que migrateUsersNullable ci-dessus.
function migrateKaraokeSessionsNullable() {
  const cols = db.prepare('PRAGMA table_info(karaoke_sessions)').all();
  const trackIdCol = cols.find((c) => c.name === 'trackId');
  if (!trackIdCol || !trackIdCol.notnull) return;

  const existingNames = cols.map((c) => c.name);
  const knownCols = ['id', 'userId', 'trackId', 'backingTrackPath', 'vocalTakePath', 'tunedVocalPath', 'finalMixPath', 'status', 'createdAt'];
  const copyCols = knownCols.filter((c) => existingNames.includes(c)).join(', ');

  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec(`
    CREATE TABLE karaoke_sessions_new (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL REFERENCES users(id),
      trackId TEXT REFERENCES tracks(id),
      backingTrackPath TEXT NOT NULL,
      vocalTakePath TEXT,
      tunedVocalPath TEXT,
      finalMixPath TEXT,
      status TEXT NOT NULL DEFAULT 'backing_ready',
      createdAt TEXT NOT NULL
    );
    INSERT INTO karaoke_sessions_new (${copyCols}) SELECT ${copyCols} FROM karaoke_sessions;
    DROP TABLE karaoke_sessions;
    ALTER TABLE karaoke_sessions_new RENAME TO karaoke_sessions;
  `);
  db.exec('PRAGMA foreign_keys = ON;');
}
migrateKaraokeSessionsNullable();

// Migrations additives légères : CREATE TABLE IF NOT EXISTS ne modifie pas
// une table déjà existante, donc les nouvelles colonnes ajoutées après coup
// passent par ici (idempotent : erreur "duplicate column" ignorée).
function addColumnIfMissing(table, column, definition) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (err) {
    if (!/duplicate column name/i.test(err.message)) throw err;
  }
}
addColumnIfMissing('karaoke_sessions', 'tunedVocalPath', 'TEXT');
addColumnIfMissing('karaoke_sessions', 'creationId', 'TEXT REFERENCES creations(id)');
addColumnIfMissing('users', 'displayName', 'TEXT');
addColumnIfMissing('tracks', 'melodyMidiPath', 'TEXT');

module.exports = db;
