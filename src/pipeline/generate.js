const path = require('path');
const { uploadFile, runModel, downloadToFile } = require('./falClient');
const { separateInstrumental } = require('./separate');

const STABLE_AUDIO_AUDIO_MODEL = 'fal-ai/stable-audio-25/audio-to-audio';
const STABLE_AUDIO_TEXT_MODEL = 'fal-ai/stable-audio-25/text-to-audio';
const DEFAULT_STRENGTH = 0.75;
// Stable Audio 2.5's audio-to-audio endpoint requires a non-empty `prompt`
// (confirmed via a real call: 422 "Field required" without one) — this
// covers the "juste l'audio, pas de texte" combo without asking the user
// for text they don't want to provide.
const DEFAULT_STYLE_PROMPT = 'instrumental music in the same style as the reference audio';

// Audio file + style prompt (prompt optionnel, voir DEFAULT_STYLE_PROMPT) ->
// variante instrumentale générée. Pipeline : Demucs retire la voix de la
// source (separate.js) -> l'instrumental propre sert de référence
// audio-to-audio à Stable Audio 2.5. Stable Audio 2.5 n'a pas de paramètre
// de contrôle vocal propre, donc retirer la voix de la source en amont est
// ce qui garde effectivement les voix hors du résultat (une consigne texte
// "no vocals" seule n'était pas fiable).
//
// `durationSeconds` est optionnel : quand omis, Stable Audio 2.5 calant par
// défaut sur la longueur de la source (séparée), ce qui est le comportement
// par défaut de l'app — l'utilisateur peut le surcharger explicitement.
async function generateVariantFromAudio(audioPath, workDir, { prompt, durationSeconds, strength } = {}) {
  const instrumentalPath = await separateInstrumental(audioPath, workDir);
  const referenceAudioUrl = await uploadFile(instrumentalPath, 'audio/wav');

  const input = {
    prompt: prompt && prompt.trim() ? prompt : DEFAULT_STYLE_PROMPT,
    audio_url: referenceAudioUrl,
    strength: strength ?? DEFAULT_STRENGTH,
  };
  if (durationSeconds) input.total_seconds = durationSeconds;

  const result = await runModel(STABLE_AUDIO_AUDIO_MODEL, input);

  const outPath = path.join(workDir, 'variant.wav');
  await downloadToFile(result.audio.url, outPath);
  return outPath;
}

// Texte seul (aucun fichier de référence) -> génération text-to-audio
// directe, sans étape Demucs (rien à séparer). `prompt` est ici réellement
// obligatoire : sans audio de référence, c'est la seule information dont le
// modèle dispose.
async function generateFromPrompt(workDir, { prompt, durationSeconds } = {}) {
  const input = { prompt };
  // Le endpoint text-to-audio utilise `seconds_total`, pas `total_seconds`
  // (nom différent de l'endpoint audio-to-audio) — confirmé via le schéma
  // OpenAPI de Fal.ai. Avant ce correctif, la durée choisie par
  // l'utilisateur était silencieusement ignorée en génération texte seul
  // (le modèle retombait sur son défaut de 190s).
  if (durationSeconds) input.seconds_total = durationSeconds;

  const result = await runModel(STABLE_AUDIO_TEXT_MODEL, input);

  const outPath = path.join(workDir, 'variant.wav');
  await downloadToFile(result.audio.url, outPath);
  return outPath;
}

module.exports = { generateVariantFromAudio, generateFromPrompt };
