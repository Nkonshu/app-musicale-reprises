const { hashFile, getConsent } = require('../consent');

// Requires req.file (multer) to already be set. Blocks the request with 403
// unless a prior, matching consent record exists for this exact file's hash.
function requireConsent(req, res, next) {
  if (!req.file) {
    return res.status(400).json({ error: "Aucun fichier reçu." });
  }
  const fileHash = hashFile(req.file.path);
  const consent = getConsent(fileHash);
  if (!consent || !consent.accepted) {
    return res.status(403).json({
      error: "Consentement requis avant de traiter ce fichier.",
      fileHash,
      hint: "Appelle POST /api/consent avec ce fileHash et accepted:true au préalable.",
    });
  }
  req.fileHash = fileHash;
  req.consent = consent;
  next();
}

module.exports = requireConsent;
