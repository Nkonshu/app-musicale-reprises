const db = require('./db');

// Écran 19 "Classement" — critère choisi : nombre de reprises créées
// (table `creations`, alimentée par generate-variant ET le mix karaoké
// final). Décision arbitrée faute de spécification dans le cahier des
// charges — un critère "votes reçus" serait plus riche mais suppose un
// système de partage/vote public qui n'existe pas encore.
function getLeaderboard(limit = 50) {
  return db.prepare(`
    SELECT
      u.id,
      COALESCE(u.displayName, 'Utilisateur anonyme') AS displayName,
      COUNT(c.id) AS creationsCount
    FROM users u
    JOIN creations c ON c.userId = u.id
    GROUP BY u.id
    ORDER BY creationsCount DESC, u.createdAt ASC
    LIMIT ?
  `).all(limit);
}

// Rang d'un utilisateur précis, même s'il n'est pas dans le top affiché —
// utile pour lui montrer "tu es #47" sans avoir à charger tout le classement.
function getUserRank(userId) {
  const row = db.prepare(`
    WITH ranked AS (
      SELECT u.id, COUNT(c.id) AS creationsCount,
        RANK() OVER (ORDER BY COUNT(c.id) DESC, u.createdAt ASC) AS rank
      FROM users u
      JOIN creations c ON c.userId = u.id
      GROUP BY u.id
    )
    SELECT rank, creationsCount FROM ranked WHERE id = ?
  `).get(userId);
  return row || { rank: null, creationsCount: 0 };
}

module.exports = { getLeaderboard, getUserRank };
