// Test ponctuel — appelle directement le pipeline text-to-audio (Stable
// Audio 2.5 via Fal.ai) avec le prompt genere par style-dna-to-prompt.py,
// pour ecouter ce que ca donne. Contourne le serveur HTTP (auth/credits)
// puisque c'est un test interne, pas une vraie requete utilisateur.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { generateFromPrompt } = require('../src/pipeline/generate');

async function main() {
  const prompt = fs.readFileSync(path.join(__dirname, '..', 'downloads', 'bendskin-prompt.txt'), 'utf8').trim();
  const workDir = path.join(__dirname, '..', 'downloads', 'bendskin-test-generation');
  fs.mkdirSync(workDir, { recursive: true });

  console.log('Prompt utilise :\n' + prompt + '\n');
  console.log('Generation en cours (Stable Audio 2.5, text-to-audio)...');

  const outPath = await generateFromPrompt(workDir, { prompt, durationSeconds: 30 });
  console.log('\nOK, resultat : ' + outPath);
}

main().catch((err) => {
  console.error('ECHEC :', err.message);
  process.exit(1);
});
