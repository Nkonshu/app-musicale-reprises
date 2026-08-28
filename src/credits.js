const db = require('./db');

// Coûts fixes en crédits par action, configurables via env. Calés sur les
// coûts réels mesurés côté Fal.ai (voir mémoire projet) : Demucs
// $0.0007/sec (plafonné à MAX_INPUT_SECONDS) + Stable Audio 2.5 $0.20 fixe
// pour generate-variant ; Demucs seul pour une session karaoké.
const COSTS = {
  generateVariant: parseInt(process.env.CREDIT_COST_GENERATE, 10) || 25,
  karaokeSession: parseInt(process.env.CREDIT_COST_KARAOKE, 10) || 10,
};

// Désactivé par défaut (demande explicite du 2026-08-26) : le système existe
// toujours (table users.credits, parrainage qui l'alimente) mais n'est plus
// appliqué tant que CREDITS_ENABLED n'est pas remis à "true". checkBalance
// et consume deviennent des no-op — aucune route appelante n'a besoin de
// changer.
const ENABLED = process.env.CREDITS_ENABLED === 'true';

function insufficientCredits(needed, have) {
  const err = new Error(`Crédits insuffisants (nécessaire : ${needed}, disponible : ${have}).`);
  err.status = 402;
  throw err;
}

// Vérifie le solde SANS débiter — à appeler avant de lancer un pipeline
// payant côté fournisseurs, pour ne jamais engager un coût réel si
// l'utilisateur n'a de toute façon pas les crédits.
function checkBalance(userId, action) {
  const cost = COSTS[action];
  if (!ENABLED) return cost;
  const user = db.prepare('SELECT credits FROM users WHERE id = ?').get(userId);
  if (!user || user.credits < cost) insufficientCredits(cost, user ? user.credits : 0);
  return cost;
}

// Débite APRÈS succès du pipeline — un échec côté fournisseur (Fal.ai/etc.)
// ne doit pas coûter de crédits à l'utilisateur, même si l'appel a un coût
// réel pour nous.
function consume(userId, action) {
  const cost = COSTS[action];
  if (!ENABLED) return cost;
  db.prepare('UPDATE users SET credits = credits - ? WHERE id = ?').run(cost, userId);
  return cost;
}

module.exports = { COSTS, ENABLED, checkBalance, consume };
