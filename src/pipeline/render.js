const path = require('path');
const { execFile } = require('child_process');

const FLUIDSYNTH_BIN = path.join(
  __dirname, '..', '..', 'fluidsynth-bin', 'fluidsynth-v2.6.0-win10-x64-cpp11', 'bin', 'fluidsynth.exe'
);
const SOUNDFONT = path.join(__dirname, '..', '..', 'soundfonts', 'GeneralUser-GS.sf2');

// Deterministic synthesis, no AI involved: renders a MIDI file to a playable
// WAV using a General MIDI soundfont, so it can be used as melody-conditioning
// audio for a generation model afterwards.
function renderMidiToWav(midiPath, outPath) {
  return new Promise((resolve, reject) => {
    execFile(
      FLUIDSYNTH_BIN,
      ['-ni', '-F', outPath, '-r', '44100', SOUNDFONT, midiPath],
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`fluidsynth render failed: ${stderr || err.message}`));
        resolve(outPath);
      }
    );
  });
}

module.exports = { renderMidiToWav };
