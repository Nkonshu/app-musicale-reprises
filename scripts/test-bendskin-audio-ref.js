// Test ponctuel — genere a partir d'une reference AUDIO reelle (le morceau
// le plus representatif du corpus, choisi par select-representative-track.py)
// plutot que du texte seul, combinee avec le prompt Style DNA comme
// modificateur et des parametres utilisateur (duree, intensite).
//
// L'API Fal.ai (audio-to-audio) n'accepte qu'une seule reference a la fois
// - pas les 10 morceaux en meme temps, voir la discussion avec
// l'utilisateur - donc ce script se sert du morceau le plus proche de la
// moyenne statistique du corpus comme porte-etendard.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { generateVariantFromAudio } = require('../src/pipeline/generate');

async function main() {
  const referenceFile = process.argv[2];
  const strength = process.argv[3] ? parseFloat(process.argv[3]) : 0.7;
  const durationSeconds = process.argv[4] ? parseInt(process.argv[4], 10) : 30;

  if (!referenceFile) {
    console.error('Usage: node scripts/test-bendskin-audio-ref.js <fichier-reference.mp3> [strength] [duree]');
    process.exit(1);
  }

  const referencePath = path.join(__dirname, '..', 'downloads', 'bendskin', referenceFile);
  const prompt = fs.readFileSync(path.join(__dirname, '..', 'downloads', 'bendskin-prompt.txt'), 'utf8').trim();
  const workDir = path.join(__dirname, '..', 'downloads', 'bendskin-test-generation-audioref');
  fs.mkdirSync(workDir, { recursive: true });

  console.log('Reference audio : ' + referenceFile);
  console.log('Prompt modificateur : ' + prompt);
  console.log('Intensite (strength) : ' + strength + ' | Duree : ' + durationSeconds + 's\n');
  console.log('Generation en cours (Stable Audio 2.5, audio-to-audio, Demucs en amont)...');

  const outPath = await generateVariantFromAudio(referencePath, workDir, { prompt, strength, durationSeconds });
  console.log('\nOK, resultat : ' + outPath);
}

main().catch((err) => {
  console.error('ECHEC :', err.message);
  process.exit(1);
});
