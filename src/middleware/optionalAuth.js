const { getUserByToken } = require('../auth');

// Comme requireAuth, mais ne bloque jamais : résout req.user si un token
// valide est présent, sinon laisse req.user undefined et continue. Utile
// pour des routes publiques dont le comportement varie selon qui appelle
// (ex. /api/catalogue : statut par défaut visible à tous, mais un filtre
// explicite sur un statut non public doit rester réservé aux admins).
function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    const user = getUserByToken(token);
    if (user) req.user = user;
  }
  next();
}

module.exports = optionalAuth;
