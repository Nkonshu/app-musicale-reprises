// Doit être monté après requireAuth (dépend de req.user).
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Réservé aux administrateurs.' });
  }
  next();
}

module.exports = requireAdmin;
