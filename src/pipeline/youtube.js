const path = require('path');
const ytdlp = require('yt-dlp-exec');
const ffmpegPath = require('ffmpeg-static');

// Outil personnel pour récupérer rapidement une référence audio sans passer
// par un export/upload manuel. Le fichier obtenu passe ensuite par le même
// circuit que n'importe quel fichier importé (consentement +
// /api/generate-variant) : rien ne contourne l'attestation de droits déjà
// en place ailleurs dans l'app.
//
// Le titre réel de la vidéo est récupéré séparément (appel métadonnées
// seul, sans téléchargement) plutôt que d'utiliser l'URL brute comme nom de
// fichier côté client — un lien complet en guise de titre casse l'affichage
// (titre sur deux lignes qui pousse les boutons hors de leur alignement).
async function downloadYoutubeAudio(url, workDir) {
  let title = null;
  try {
    const info = await ytdlp(url, { dumpSingleJson: true, noPlaylist: true, skipDownload: true });
    title = typeof info === 'object' && info?.title ? info.title : null;
  } catch {
    // Le titre est un bonus d'affichage, pas un pré-requis : si la
    // récupération échoue, le téléchargement de l'audio suit son cours.
  }

  const outputTemplate = path.join(workDir, 'youtube-audio.%(ext)s');
  await ytdlp(url, {
    extractAudio: true,
    audioFormat: 'mp3',
    audioQuality: 0,
    output: outputTemplate,
    noPlaylist: true,
    ffmpegLocation: ffmpegPath,
  });
  return { path: path.join(workDir, 'youtube-audio.mp3'), title };
}

module.exports = { downloadYoutubeAudio };
