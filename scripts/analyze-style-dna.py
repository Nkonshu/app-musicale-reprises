#!/usr/bin/env python3
"""
Style DNA v2 - etude de faisabilite (demande utilisateur, 2026-08-28).

Analyse un corpus de morceaux d'un meme style musical et en extrait des
metriques agregees statistiquement : rythme, tonalite/harmonie approximative,
texture spectrale, structure, energie, production.

~24-25 metriques reelles (calculees, pas inventees) plutot que les 50-100
imaginees au depart - voir la discussion avec l'utilisateur pour le detail
categorie par categorie de ce qui est fiable vs hors de portee avec les
outils d'analyse audio actuels sur de l'audio reel (pas du MIDI propre) :
  - PAS de detection d'instruments precis, PAS de patterns individuels
    grosse-caisse/caisse-claire/hi-hat (necessiterait une separation de
    sources fiable qu'on n'a pas).
  - PAS d'accords enrichis (7e/9e), cadences, renversements - juste
    accord/mode dominant approximatif (majeur/mineur par correlation de
    templates chroma).
  - PAS d'emotion/ambiance ("joyeux", "melancolique") - trop subjectif,
    biais culturel fort des modeles existants sur des styles sous-
    representes.
  - Melodie (ambitus, direction) : best-effort via pyin sur le mix complet,
    donc bruite (pas une transcription propre) - marque comme tel.

Usage:
  python scripts/analyze-style-dna.py <dossier-audio> [nom-du-style]
"""
import sys
import os
import glob
import json
import numpy as np
import librosa

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

KEY_NAMES = ['Do', 'Do#', 'Ré', 'Ré#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si']
AUDIO_EXTENSIONS = ('.mp3', '.wav', '.m4a', '.flac', '.ogg')

# Gabarits d'accords triades (majeur/mineur) sur les 12 tons, pour une
# estimation d'accord/mode approximative par correlation avec le chroma -
# pas une reconnaissance d'accords fine (7e, renversements... hors de
# portee), juste majeur vs mineur dominant.
MAJOR_TEMPLATE = np.array([1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0])
MINOR_TEMPLATE = np.array([1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0])


def estimate_chords(chroma):
    """Pour chaque frame, trouve la triade (racine, mode) la plus correlee.
    Retourne la liste des labels ('Do maj', 'Ré min', ...) par frame."""
    labels = []
    for frame in chroma.T:
        best_score, best_label = -1, None
        for root in range(12):
            maj = np.roll(MAJOR_TEMPLATE, root)
            minr = np.roll(MINOR_TEMPLATE, root)
            score_maj = np.dot(frame, maj)
            score_min = np.dot(frame, minr)
            if score_maj > best_score:
                best_score, best_label = score_maj, f'{KEY_NAMES[root]} maj'
            if score_min > best_score:
                best_score, best_label = score_min, f'{KEY_NAMES[root]} min'
        labels.append(best_label)
    return labels


def segment_boundaries(rms, sr, hop=512):
    rms_smooth = np.convolve(rms, np.ones(20) / 20, mode='same')
    diffs = np.abs(np.diff(rms_smooth))
    threshold = np.mean(diffs) + 2 * np.std(diffs)
    boundaries = np.where(diffs > threshold)[0]
    min_gap_frames = int(3 * sr / hop)
    # Exclut les 2 premieres/dernieres secondes : le convolve('same') cree
    # un artefact de bord (fenetre partiellement hors-signal) qui se
    # confondait avec une vraie frontiere de section a t=0.
    edge_frames = int(2 * sr / hop)
    boundaries = boundaries[(boundaries > edge_frames) & (boundaries < len(diffs) - edge_frames)]
    grouped = []
    for b in boundaries:
        if not grouped or (b - grouped[-1]) > min_gap_frames:
            grouped.append(b)
    return grouped


def analyze_track(path):
    y, sr = librosa.load(path, sr=22050, mono=True)
    duration = librosa.get_duration(y=y, sr=sr)
    hop = 512

    # --- Rythme ---
    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
    tempo = float(np.asarray(tempo).flatten()[0])
    beat_times = librosa.frames_to_time(beat_frames, sr=sr)

    onset_env = librosa.onset.onset_strength(y=y, sr=sr)
    onset_frames = librosa.onset.onset_detect(onset_envelope=onset_env, sr=sr)
    onset_times = librosa.frames_to_time(onset_frames, sr=sr)
    onset_density = len(onset_times) / duration if duration > 0 else 0.0

    # Syncope : part des onsets loin (>120ms) du temps le plus proche
    if len(beat_times) > 1 and len(onset_times) > 0:
        dists = np.min(np.abs(onset_times[:, None] - beat_times[None, :]), axis=1)
        syncopation_ratio = float(np.mean(dists > 0.12))
    else:
        syncopation_ratio = None

    # Complexite rythmique : entropie des intervalles inter-onsets (IOI)
    if len(onset_times) > 2:
        iois = np.diff(onset_times)
        hist, _ = np.histogram(iois, bins=10)
        hist = hist[hist > 0]
        probs = hist / hist.sum()  # densite=True donnait des valeurs >1 -> entropie negative, faux
        rhythmic_entropy = float(-np.sum(probs * np.log2(probs)) / np.log2(len(probs))) if len(probs) > 1 else 0.0
    else:
        rhythmic_entropy = None

    # Swing/groove : variabilite du ratio entre IOI consecutifs (proxy)
    if len(onset_times) > 3:
        iois = np.diff(onset_times)
        ratios = iois[1::2] / np.clip(iois[0::2][:len(iois[1::2])], 1e-6, None)
        swing_ratio = float(np.median(ratios))
    else:
        swing_ratio = None

    # Signature rythmique approx : correlation de l'enveloppe d'onset avec
    # elle-meme decalee de N battements (N=2,3,4,6) - low-confidence.
    meter_guess = 'indetermine'
    if len(beat_frames) > 8:
        beat_period_frames = int(np.median(np.diff(beat_frames)))
        best_n, best_corr = None, -1
        for n in (2, 3, 4, 6):
            lag = beat_period_frames * n
            if lag >= len(onset_env):
                continue
            c = np.corrcoef(onset_env[:-lag], onset_env[lag:])[0, 1]
            if not np.isnan(c) and c > best_corr:
                best_corr, best_n = c, n
        meter_guess = {2: '2/4 (probable)', 3: '3/4 (probable)', 4: '4/4 (probable)', 6: '6/8 (probable)'}.get(best_n, 'indetermine')

    # --- Energie / dynamique ---
    rms = librosa.feature.rms(y=y)[0]
    rms_times = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=hop)
    rms_mean = float(np.mean(rms))
    dynamic_range = float(np.percentile(rms, 95) - np.percentile(rms, 5))
    # calm_ratio/explosive_ratio ne sont PAS calcules ici : un seuil relatif
    # au morceau lui-meme (son propre 25e/75e percentile) donne toujours
    # ~0.25 par construction, quel que soit le morceau - tautologique, testé
    # et confirme sur le corpus bend-skin. Calcules apres coup dans main()
    # avec un seuil absolu commun a tout le corpus (voir plus bas).
    climax_position_ratio = float(rms_times[int(np.argmax(rms))] / duration) if duration > 0 else None

    # Pente de fin (10 dernieres secondes) : fondu (negatif) vs coupure nette (~0)
    tail_mask = rms_times > max(0, duration - 10)
    if np.sum(tail_mask) > 2:
        tail_slope = float(np.polyfit(rms_times[tail_mask], rms[tail_mask], 1)[0])
    else:
        tail_slope = None

    # --- Texture spectrale / production ---
    spectral_centroid = float(np.mean(librosa.feature.spectral_centroid(y=y, sr=sr)))
    spectral_bandwidth = float(np.mean(librosa.feature.spectral_bandwidth(y=y, sr=sr)))
    spectral_rolloff = float(np.mean(librosa.feature.spectral_rolloff(y=y, sr=sr)))
    spectral_flatness = float(np.mean(librosa.feature.spectral_flatness(y=y)))
    spectral_contrast = float(np.mean(librosa.feature.spectral_contrast(y=y, sr=sr)))
    zcr = float(np.mean(librosa.feature.zero_crossing_rate(y=y)))
    crest_factor_db = float(20 * np.log10(np.max(np.abs(y)) / (rms_mean + 1e-9)))

    # Largeur stereo (necessite le fichier en stereo - recharge separement)
    stereo_width = None
    try:
        y_stereo, _ = librosa.load(path, sr=22050, mono=False)
        if y_stereo.ndim == 2 and y_stereo.shape[0] == 2:
            corr = np.corrcoef(y_stereo[0], y_stereo[1])[0, 1]
            stereo_width = float(1 - corr) if not np.isnan(corr) else None
    except Exception:
        pass

    # --- Tonalite / harmonie approximative ---
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    key_idx = int(np.argmax(chroma.mean(axis=1)))
    key = KEY_NAMES[key_idx]

    # Regroupe par blocs de 4 temps (pas battement par battement) avant
    # d'estimer les accords : une estimation par frame/battement est trop
    # instable (chaque frame peut "flipper" vers un accord different) et
    # gonflait artificiellement le nombre d'accords distincts detectes.
    if len(beat_frames) > 4:
        grouped_frames = beat_frames[::4]
        chroma_beat = librosa.util.sync(chroma, grouped_frames)
    else:
        chroma_beat = chroma
    chord_labels = estimate_chords(chroma_beat)
    modes = [c.split()[1] for c in chord_labels]
    dominant_mode = max(set(modes), key=modes.count) if modes else None
    distinct_chords = len(set(chord_labels))

    # --- Structure ---
    boundaries = segment_boundaries(rms, sr, hop)
    n_segments_approx = len(boundaries) + 1
    intro_duration = float(rms_times[boundaries[0]]) if boundaries else duration

    # --- Melodie (best-effort, bruite sur mix polyphonique) ---
    # La direction est calculee PAR SECTION (entre deux frontieres de
    # structure), pas sur le morceau entier : une tendance lineaire sur 5
    # minutes ecrase presque toujours a "stable" (confirme sur le corpus
    # bend-skin : 10/10 "stable"), alors que la direction se joue a
    # l'echelle d'une phrase/section, pas du morceau.
    melodic_range_semitones, melodic_direction, melodic_direction_dist = None, None, None
    try:
        f0, voiced_flag, _ = librosa.pyin(
            y, fmin=librosa.note_to_hz('C2'), fmax=librosa.note_to_hz('C6'), sr=sr, hop_length=hop,
        )
        f0_voiced_all = f0[voiced_flag]
        if len(f0_voiced_all) > 10:
            midi_all = librosa.hz_to_midi(f0_voiced_all)
            melodic_range_semitones = float(np.max(midi_all) - np.min(midi_all))

            section_edges = [0] + list(boundaries) + [len(f0)]
            directions = []
            for start, end in zip(section_edges[:-1], section_edges[1:]):
                seg_voiced = voiced_flag[start:end]
                seg_f0 = f0[start:end][seg_voiced]
                if len(seg_f0) < 10:
                    continue
                seg_midi = librosa.hz_to_midi(seg_f0)
                slope = np.polyfit(np.arange(len(seg_midi)), seg_midi, 1)[0]
                directions.append('ascendante' if slope > 0.01 else ('descendante' if slope < -0.01 else 'stable'))
            if directions:
                counts = {d: directions.count(d) for d in set(directions)}
                melodic_direction = max(counts, key=counts.get)
                melodic_direction_dist = {d: round(c / len(directions), 2) for d, c in counts.items()}
    except Exception:
        pass

    return {
        'file': os.path.basename(path),
        'duration_sec': round(duration, 1),
        'tempo_bpm': round(tempo, 1),
        'meter_guess': meter_guess,
        'syncopation_ratio': round(syncopation_ratio, 3) if syncopation_ratio is not None else None,
        'rhythmic_entropy': round(rhythmic_entropy, 3) if rhythmic_entropy is not None else None,
        'swing_ratio': round(swing_ratio, 3) if swing_ratio is not None else None,
        'onset_density_per_sec': round(onset_density, 2),
        'key_estimate': key,
        'dominant_chord_mode': dominant_mode,
        'distinct_chords_approx': distinct_chords,
        'melodic_range_semitones': round(melodic_range_semitones, 1) if melodic_range_semitones is not None else None,
        'melodic_direction': melodic_direction,
        'melodic_direction_distribution': melodic_direction_dist,
        'rms_mean': round(rms_mean, 4),
        'dynamic_range': round(dynamic_range, 4),
        'climax_position_ratio': round(climax_position_ratio, 3) if climax_position_ratio is not None else None,
        'ending_slope': round(tail_slope, 6) if tail_slope is not None else None,
        'spectral_centroid_hz': round(spectral_centroid, 1),
        'spectral_bandwidth_hz': round(spectral_bandwidth, 1),
        'spectral_rolloff_hz': round(spectral_rolloff, 1),
        'spectral_flatness': round(spectral_flatness, 5),
        'spectral_contrast': round(spectral_contrast, 3),
        'zero_crossing_rate': round(zcr, 4),
        'crest_factor_db': round(crest_factor_db, 2),
        'stereo_width': round(stereo_width, 3) if stereo_width is not None else None,
        'n_segments_approx': n_segments_approx,
        'intro_duration_sec': round(intro_duration, 1),
        '_rms': rms,  # usage interne (calm/explosive_ratio globaux dans main) - retire avant sauvegarde JSON
    }


NUMERIC_KEYS = [
    'duration_sec', 'tempo_bpm', 'syncopation_ratio', 'rhythmic_entropy', 'swing_ratio',
    'onset_density_per_sec', 'distinct_chords_approx', 'melodic_range_semitones',
    'rms_mean', 'dynamic_range', 'calm_ratio', 'explosive_ratio', 'climax_position_ratio',
    'ending_slope', 'spectral_centroid_hz', 'spectral_bandwidth_hz', 'spectral_rolloff_hz',
    'spectral_flatness', 'spectral_contrast', 'zero_crossing_rate', 'crest_factor_db',
    'stereo_width', 'n_segments_approx', 'intro_duration_sec',
]


def add_calm_explosive_ratios(results):
    """calm_ratio/explosive_ratio avec un seuil ABSOLU commun a tout le
    corpus (25e/75e percentile du RMS de tous les morceaux regroupes),
    plutot qu'un seuil relatif a chaque morceau qui donnait toujours ~0.25
    par construction (tautologique - voir la note dans analyze_track)."""
    all_rms = np.concatenate([r['_rms'] for r in results])
    calm_threshold = np.percentile(all_rms, 25)
    explosive_threshold = np.percentile(all_rms, 75)
    for r in results:
        r['calm_ratio'] = round(float(np.mean(r['_rms'] < calm_threshold)), 3)
        r['explosive_ratio'] = round(float(np.mean(r['_rms'] > explosive_threshold)), 3)
        del r['_rms']
CATEGORICAL_KEYS = ['meter_guess', 'key_estimate', 'dominant_chord_mode', 'melodic_direction']


def aggregate(results):
    stats = {}
    for k in NUMERIC_KEYS:
        values = [r[k] for r in results if r.get(k) is not None]
        if not values:
            continue
        stats[k] = {
            'mean': round(float(np.mean(values)), 4),
            'std': round(float(np.std(values)), 4),
            'min': round(float(np.min(values)), 4),
            'max': round(float(np.max(values)), 4),
        }
    for k in CATEGORICAL_KEYS:
        values = [r[k] for r in results if r.get(k) is not None]
        if not values:
            continue
        counts = {v: values.count(v) for v in set(values)}
        stats[k] = {'most_common': max(counts, key=counts.get), 'distribution': counts}
    return stats


def main():
    if len(sys.argv) < 2:
        print('Usage: python scripts/analyze-style-dna.py <dossier-audio> [nom-du-style]', file=sys.stderr)
        sys.exit(1)

    audio_dir = sys.argv[1]
    style_name = sys.argv[2] if len(sys.argv) > 2 else os.path.basename(os.path.normpath(audio_dir))

    files = sorted([f for f in glob.glob(os.path.join(audio_dir, '*')) if f.lower().endswith(AUDIO_EXTENSIONS)])
    if not files:
        print(f'Aucun fichier audio trouve dans {audio_dir}', file=sys.stderr)
        sys.exit(1)

    print(f'{len(files)} fichier(s) a analyser...', file=sys.stderr)
    results = []
    for f in files:
        print(f'  -> {os.path.basename(f)}', file=sys.stderr)
        try:
            results.append(analyze_track(f))
        except Exception as e:
            print(f'     ECHEC : {e}', file=sys.stderr)

    if not results:
        print('Aucun morceau analyse avec succes.', file=sys.stderr)
        sys.exit(1)

    add_calm_explosive_ratios(results)

    output = {
        'style': style_name,
        'corpus_size': len(results),
        'tracks': results,
        'aggregate_stats': aggregate(results),
    }

    out_path = os.path.join(os.path.dirname(os.path.normpath(audio_dir)), f'{style_name}-style-dna.json')
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f'\nResultat sauvegarde : {out_path}', file=sys.stderr)
    print(f'{len(results)}/{len(files)} morceaux analyses avec succes.', file=sys.stderr)


if __name__ == '__main__':
    main()
