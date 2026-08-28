const path = require('path');
const { execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { uploadFile, runModel, downloadToFile } = require('./falClient');

const DEMUCS_MODEL = 'fal-ai/demucs';

// Demucs bills $0.0007/second of INPUT audio (Fal.ai pricing, checked
// 2026-08-25) — a full 7-8min track costs ~$0.33 to separate just to end up
// as a 15-40s generated variant. Capping the input keeps cost predictable
// regardless of what the user uploads. Override with MAX_INPUT_SECONDS.
const MAX_INPUT_SECONDS = parseInt(process.env.MAX_INPUT_SECONDS, 10) || 60;

function getDuration(inputPath) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, ['-i', inputPath], (err, stdout, stderr) => {
      // ffmpeg -i without -y/output exits non-zero even on success; that's expected.
      const match = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(stderr || '');
      if (!match) return reject(new Error('Impossible de lire la durée du fichier audio.'));
      const [, h, m, s] = match;
      resolve(parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseFloat(s));
    });
  });
}

// Converts to WAV, trimming to MAX_INPUT_SECONDS from the start if the
// source is longer. Simple fixed-window trim (no chorus/hook detection) —
// good enough for a cost cap, not for picking the "best" excerpt.
async function toWav(inputPath, outPath) {
  const duration = await getDuration(inputPath);
  const args = ['-y', '-i', inputPath];
  if (duration > MAX_INPUT_SECONDS) {
    args.push('-t', String(MAX_INPUT_SECONDS));
  }
  args.push('-ac', '2', '-ar', '44100', outPath);
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, (err) => {
      if (err) return reject(err);
      resolve(outPath);
    });
  });
}

function mixStems(stemPaths, outPath) {
  return new Promise((resolve, reject) => {
    const args = [];
    stemPaths.forEach((p) => args.push('-i', p));
    args.push(
      '-filter_complex', `amix=inputs=${stemPaths.length}:duration=longest:normalize=0`,
      '-ar', '44100', '-y', outPath
    );
    execFile(ffmpegPath, args, (err) => {
      if (err) return reject(err);
      resolve(outPath);
    });
  });
}

// Audio file -> { instrumentalPath, vocalsPath }, via Demucs (Fal.ai) source
// separation. instrumentalPath mixes everything EXCEPT vocals back into one
// track (guarantees no vocals reach the generation model — neither Stable
// Audio 2.5 nor a text prompt alone reliably suppresses vocals once they're
// in the source). vocalsPath is the isolated vocal stem, used as the melody
// reference for autotune v2 (see transcribeMelody in karaoke.js) — kept
// separate from instrumentalPath rather than discarded like before.
async function separateStems(audioPath, workDir) {
  const wavPath = path.join(workDir, 'separate_input.wav');
  await toWav(audioPath, wavPath);

  const sourceUrl = await uploadFile(wavPath, 'audio/wav');
  const result = await runModel(DEMUCS_MODEL, {
    audio_url: sourceUrl,
    model: 'htdemucs',
    stems: ['vocals', 'drums', 'bass', 'other'],
    output_format: 'wav',
  });

  const nonVocalStems = ['drums', 'bass', 'other', 'guitar', 'piano'].filter((k) => result[k]);
  const stemPaths = [];
  for (const key of nonVocalStems) {
    const stemPath = path.join(workDir, `stem_${key}.wav`);
    await downloadToFile(result[key].url, stemPath);
    stemPaths.push(stemPath);
  }

  const instrumentalPath = path.join(workDir, 'instrumental.wav');
  await mixStems(stemPaths, instrumentalPath);

  let vocalsPath = null;
  if (result.vocals) {
    vocalsPath = path.join(workDir, 'stem_vocals.wav');
    await downloadToFile(result.vocals.url, vocalsPath);
  }

  return { instrumentalPath, vocalsPath };
}

async function separateInstrumental(audioPath, workDir) {
  const { instrumentalPath } = await separateStems(audioPath, workDir);
  return instrumentalPath;
}

module.exports = { separateInstrumental, separateStems };
