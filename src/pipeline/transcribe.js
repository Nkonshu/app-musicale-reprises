const path = require('path');
const { execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { uploadFile, runPrediction, downloadToFile } = require('./replicateClient');

function toWav(inputPath, outPath) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, ['-y', '-i', inputPath, '-ac', '1', '-ar', '22050', outPath], (err) => {
      if (err) return reject(err);
      resolve(outPath);
    });
  });
}

// Audio file -> MIDI file, via Replicate's rhelsing/basic-pitch (Spotify Basic Pitch).
async function transcribeAudioToMidi(inputPath, workDir) {
  const wavPath = path.join(workDir, 'transcribe_input.wav');
  await toWav(inputPath, wavPath);

  const audioUrl = await uploadFile(wavPath);
  const midiUrl = await runPrediction(process.env.BASIC_PITCH_VERSION, { audio_file: audioUrl });

  const midiPath = path.join(workDir, 'transcribed.mid');
  await downloadToFile(midiUrl, midiPath);
  return midiPath;
}

module.exports = { transcribeAudioToMidi, toWav };
