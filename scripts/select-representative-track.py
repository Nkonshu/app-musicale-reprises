#!/usr/bin/env python3
"""
Choisit, dans un corpus deja analyse (style-dna.json), le morceau le plus
"representatif" statistiquement : celui dont les metriques s'ecartent le
moins de la moyenne du corpus (medoide), sur un sous-ensemble de metriques
cle plutot que les 23 en entier (certaines, comme intro_duration ou
n_segments_approx, sont plus liees a la duree/edition du fichier qu'au
caractere stylistique).

Ce morceau sert ensuite de reference audio unique pour generateVariantFromAudio
(l'API Fal.ai n'accepte qu'une seule reference a la fois - pas les 10 en
meme temps, voir la discussion avec l'utilisateur) - le texte/Style DNA
vient en plus, comme modificateur, pas comme seule source.

Usage:
  python scripts/select-representative-track.py <style-dna.json>
"""
import sys
import json

sys.stdout.reconfigure(encoding='utf-8')

KEY_METRICS = [
    'tempo_bpm', 'syncopation_ratio', 'onset_density_per_sec',
    'rhythmic_entropy', 'spectral_centroid_hz', 'crest_factor_db',
]


def main():
    if len(sys.argv) < 2:
        print('Usage: python scripts/select-representative-track.py <style-dna.json>', file=sys.stderr)
        sys.exit(1)

    with open(sys.argv[1], 'r', encoding='utf-8') as f:
        dna = json.load(f)

    tracks = dna['tracks']
    stats = dna['aggregate_stats']

    # Normalise chaque metrique par son ecart-type de corpus (sinon le BPM,
    # de grande amplitude, ecraserait des metriques a plus petite echelle
    # comme syncopation_ratio dans le calcul de distance).
    best_track, best_score = None, float('inf')
    scores = []
    for t in tracks:
        dist = 0.0
        for k in KEY_METRICS:
            std = stats[k]['std'] or 1e-9
            mean = stats[k]['mean']
            dist += ((t[k] - mean) / std) ** 2
        dist = dist ** 0.5
        scores.append((t['file'], round(dist, 3)))
        if dist < best_score:
            best_score, best_track = dist, t['file']

    scores.sort(key=lambda x: x[1])
    print('Classement (le plus representatif en premier) :', file=sys.stderr)
    for name, d in scores:
        print(f'  {d:6.3f}  {name}', file=sys.stderr)

    print(best_track)


if __name__ == '__main__':
    main()
