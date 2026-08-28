#!/usr/bin/env node
// Script experimental — etude de faisabilite demandee par l'utilisateur :
// lit un fichier texte, en extrait un ou plusieurs liens YouTube, telecharge
// l'audio (mp3) de chacun. Autonome, pas branche sur le reste de l'app.
//
// Reutilise yt-dlp-exec + ffmpeg-static, deja des dependances du projet.
const fs = require('fs');
const path = require('path');
const ytdlp = require('yt-dlp-exec');
const ffmpegPath = require('ffmpeg-static');

const YOUTUBE_URL_RE = /https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=[\w-]+(?:&\S*)?|youtu\.be\/[\w-]+(?:\?\S*)?|youtube\.com\/shorts\/[\w-]+)/gi;

function extractLinks(text) {
  const matches = text.match(YOUTUBE_URL_RE) || [];
  return [...new Set(matches)]; // dedupe, garde l'ordre d'apparition
}

async function downloadVideo(url, outDir, browser) {
  const outputTemplate = path.join(outDir, '%(title)s.%(ext)s');
  console.log(`\n→ Telechargement (audio) : ${url}`);
  const opts = {
    output: outputTemplate,
    extractAudio: true,
    audioFormat: 'mp3',
    audioQuality: 0,
    noPlaylist: true,
    ffmpegLocation: ffmpegPath,
  };
  // YouTube bloque de plus en plus les acces sans session navigateur
  // ("Sign in to confirm you're not a bot", HTTP 429) - reutiliser les
  // cookies d'un navigateur ou l'utilisateur est deja connecte est la
  // solution standard documentee par yt-dlp pour ce blocage.
  if (browser) opts.cookiesFromBrowser = browser;
  await ytdlp(url, opts);
  console.log(`OK : ${url}`);
}

async function main() {
  const inputFile = process.argv[2];
  const outDir = process.argv[3] || path.join(__dirname, '..', 'downloads');
  const browser = process.argv[4]; // ex: chrome, edge, firefox — optionnel

  if (!inputFile) {
    console.error('Usage: node scripts/download-youtube-videos.js <fichier-liens.txt> [dossier-sortie] [navigateur]');
    console.error('  navigateur (optionnel) : chrome, edge, firefox... reutilise ses cookies de session');
    console.error('  pour contourner le blocage anti-bot YouTube ("Sign in to confirm you\'re not a bot").');
    process.exit(1);
  }
  if (!fs.existsSync(inputFile)) {
    console.error(`Fichier introuvable : ${inputFile}`);
    process.exit(1);
  }

  const text = fs.readFileSync(inputFile, 'utf8');
  const links = extractLinks(text);
  if (links.length === 0) {
    console.error('Aucun lien YouTube trouve dans le fichier.');
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });
  console.log(`${links.length} lien(s) trouve(s). Sortie : ${outDir}`);

  const results = { ok: [], failed: [] };
  for (const url of links) {
    try {
      await downloadVideo(url, outDir, browser);
      results.ok.push(url);
    } catch (err) {
      console.error(`ECHEC pour ${url} : ${err.message}`);
      results.failed.push(url);
    }
  }

  console.log(`\nResume : ${results.ok.length} reussi(s), ${results.failed.length} echoue(s).`);
  if (results.failed.length) {
    console.log('Echecs :\n  ' + results.failed.join('\n  '));
  }
}

main();
