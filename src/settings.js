const db = require('./db');

// Écran 17 "Paramètres" — blob JSON libre plutôt qu'une colonne par
// réglage : évite une migration à chaque nouveau paramètre ajouté au
// design, au prix de ne pas pouvoir requêter dessus (non nécessaire ici).
function getSettings(userId) {
  const row = db.prepare('SELECT settingsJson FROM users WHERE id = ?').get(userId);
  return JSON.parse(row.settingsJson);
}

function updateSettings(userId, patch) {
  const current = getSettings(userId);
  const merged = { ...current, ...patch };
  db.prepare('UPDATE users SET settingsJson = ? WHERE id = ?').run(JSON.stringify(merged), userId);
  return merged;
}

module.exports = { getSettings, updateSettings };
