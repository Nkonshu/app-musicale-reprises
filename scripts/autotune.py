"""
Correction de hauteur façon "autotune" : détecte le pitch (Praat, via
Parselmouth), calcule la fréquence cible pour chaque point, puis
resynthétise (overlap-add) avec le pitch corrigé.

Deux modes :
- Sans référence mélodique : cible = note chromatique la plus proche
  (grille de 12 demi-tons, comme un autotune "générique").
- Avec référence mélodique (fichier MIDI) : cible = la note ACTIVE dans la
  mélodie d'origine à cet instant précis (heuristique : la note la plus
  aiguë active = ligne mélodique), avec repli sur la correction chromatique
  si aucune note n'est active à ce moment (silence/respiration). Suppose
  que la prise vocale démarre en même temps que le MIDI de référence
  (hypothèse raisonnable : l'utilisateur enregistre en écoutant la piste
  d'accompagnement, qui partage la même timeline que ce MIDI).

Usage: python autotune.py <input.wav> <output.wav> [correctionStrength 0-1] [melody.mid]
"""
import sys
import math
import parselmouth
from parselmouth.praat import call


def midi_note_to_freq(note):
    return 440.0 * (2 ** ((note - 69) / 12))


def nearest_note_frequency(freq_hz):
    if freq_hz <= 0:
        return freq_hz
    midi_note = 12 * math.log2(freq_hz / 440.0) + 69
    return midi_note_to_freq(round(midi_note))


def load_melody_events(melody_path):
    """Retourne une liste de (start_s, end_s, midi_note) à partir d'un MIDI.
    Itérer un mido.MidiFile fusionne les pistes et convertit automatiquement
    les deltas en secondes (gère les changements de tempo) — pas besoin de
    conversion manuelle ticks->secondes."""
    import mido
    mid = mido.MidiFile(melody_path)
    events = []
    active = {}
    t = 0.0
    for msg in mid:
        t += msg.time
        if msg.type == 'note_on' and msg.velocity > 0:
            active[msg.note] = t
        elif msg.type == 'note_off' or (msg.type == 'note_on' and msg.velocity == 0):
            start = active.pop(msg.note, None)
            if start is not None:
                events.append((start, t, msg.note))
    return events


def melody_target_at(events, t):
    active_notes = [note for (start, end, note) in events if start <= t < end]
    if not active_notes:
        return None
    return midi_note_to_freq(max(active_notes))  # note la plus aiguë active = mélodie


def autotune(input_path, output_path, correction_strength=1.0, melody_path=None):
    melody_events = load_melody_events(melody_path) if melody_path else None

    sound = parselmouth.Sound(input_path)
    manipulation = call(sound, "To Manipulation", 0.01, 75, 600)
    pitch_tier = call(manipulation, "Extract pitch tier")

    n_points = call(pitch_tier, "Get number of points")
    times = []
    corrected = []
    for i in range(1, n_points + 1):
        t = call(pitch_tier, "Get time from index", i)
        f = call(pitch_tier, "Get value at index", i)

        target = None
        if melody_events is not None:
            target = melody_target_at(melody_events, t)
        if target is None:
            target = nearest_note_frequency(f)

        blended = f + (target - f) * correction_strength
        times.append(t)
        corrected.append(blended)

    new_tier = call("Create PitchTier", "corrected", sound.xmin, sound.xmax)
    for t, f in zip(times, corrected):
        call(new_tier, "Add point", t, f)

    call([new_tier, manipulation], "Replace pitch tier")
    resynthesized = call(manipulation, "Get resynthesis (overlap-add)")
    resynthesized.save(output_path, "WAV")


if __name__ == "__main__":
    input_path = sys.argv[1]
    output_path = sys.argv[2]
    strength = float(sys.argv[3]) if len(sys.argv) > 3 else 1.0
    melody_path = sys.argv[4] if len(sys.argv) > 4 else None
    autotune(input_path, output_path, strength, melody_path)
    print(f"OK: {output_path}" + (f" (melodie: {melody_path})" if melody_path else " (chromatique)"))
