#!/usr/bin/env python3
"""
Traducteur Style DNA -> prompt de generation (etude de faisabilite,
2026-08-28). Lit le JSON produit par analyze-style-dna.py et le transforme
en une description technique en anglais, dans le langage auquel Stable
Audio 2.5 repond bien (voir generate.js et la decouverte bend-skin de ce
meme projet : le simple nom du genre ne suffit pas).

Deux sources combinees, PAS une seule :
  1. Les stats agregees du corpus (mesurees, cette fois automatiquement
     sur 10 morceaux plutot qu'a la main).
  2. Des faits d'instrumentation VERIFIES par recherche (Wikipedia), pas
     extraits de l'audio - l'identification d'instruments precis depuis un
     mix reel n'est pas fiable (voir les limites documentees dans
     analyze-style-dna.py). Sans ca, le prompt perdrait l'info la plus
     importante (quels instruments) que l'audio seul ne peut pas donner.

Usage:
  python scripts/style-dna-to-prompt.py <style-dna.json>
"""
import sys
import json

sys.stdout.reconfigure(encoding='utf-8')

# Faits d'instrumentation verifies par recherche (pas extraits de l'audio -
# voir GENRE_TECHNICAL_PROMPT dans UploadScreen.tsx pour la meme logique
# cote app mobile). A completer style par style au fur et a mesure. Le
# "character" est aussi tire de la source verifiee (Wikipedia decrit le
# bend-skin comme "raw and rhythmically urgent"), pas invente.
VERIFIED_INSTRUMENTATION = {
    'bendskin': {
        'instruments': 'hand drums layered with shaken soda-can maracas',
        'character': 'raw, lo-fi, street-recorded energy, unpolished and rhythmically urgent',
        'no_harmony': True,  # pas d'accords/tonalite dans l'instrumentation traditionnelle -
                              # exclut mode_phrase/chord info, qui contredisait sinon ce fait
    },
}


def instrumentation_block(style):
    """Bloc d'ouverture : instruments concrets + contrainte negative explicite
    et non ambigue plutot qu'une formulation vague ("... source material")
    qui laissait le modele libre de rajouter de l'harmonie quand meme -
    cause probable du premier essai qui ne ressemblait pas au style."""
    info = VERIFIED_INSTRUMENTATION.get(style)
    if not info:
        return None
    block = f"{info['instruments']}, {info['character']}"
    if info.get('no_harmony'):
        block += ', no melodic instruments, no bass, no synthesizers, no chords, percussion only'
    return block


def tempo_phrase(mean_bpm):
    if mean_bpm < 90:
        return f'slow tempo (~{mean_bpm:.0f} BPM)'
    if mean_bpm < 110:
        return f'moderate tempo (~{mean_bpm:.0f} BPM)'
    if mean_bpm < 140:
        return f'upbeat tempo (~{mean_bpm:.0f} BPM)'
    return f'fast tempo (~{mean_bpm:.0f} BPM)'


def syncopation_phrase(ratio):
    if ratio > 0.5:
        return 'heavily syncopated rhythm'
    if ratio > 0.3:
        return 'moderately syncopated rhythm'
    return 'mostly on-beat, straight rhythm'


def density_phrase(onsets_per_sec):
    if onsets_per_sec > 4:
        return 'dense, driving percussive layering'
    if onsets_per_sec > 2:
        return 'moderate percussive density'
    return 'sparse, spacious percussion'


def entropy_phrase(entropy):
    if entropy > 0.6:
        return 'highly varied, unpredictable rhythmic patterning'
    if entropy > 0.3:
        return 'moderately varied rhythmic patterns'
    return 'repetitive, steady rhythmic patterns'


def brightness_phrase(centroid_hz):
    if centroid_hz < 1500:
        return 'warm, dark timbre'
    if centroid_hz < 3000:
        return 'clear, bright timbre'
    return 'very bright, crisp timbre'


def dynamics_phrase(crest_db):
    if crest_db > 14:
        return 'wide natural dynamic range, not heavily compressed'
    if crest_db > 9:
        return 'moderate dynamic range'
    return 'tightly compressed, consistently loud'


def mode_phrase(mode_dist):
    maj = mode_dist.get('maj', 0)
    minr = mode_dist.get('min', 0)
    total = maj + minr
    if total == 0:
        return None
    if maj / total > 0.65:
        return 'predominantly major tonal color'
    if minr / total > 0.65:
        return 'predominantly minor tonal color'
    return 'mixing major and minor tonal colors'


def meter_phrase(meter_dist):
    most_common = max(meter_dist, key=meter_dist.get)
    label = most_common.replace(' (probable)', '')
    return f'a {label} rhythmic feel'


def build_prompt(dna):
    style = dna['style']
    stats = dna['aggregate_stats']
    info = VERIFIED_INSTRUMENTATION.get(style, {})
    parts = []

    instr = instrumentation_block(style)
    if instr:
        parts.append(instr)

    # Rythme d'abord, juste apres l'instrumentation : c'est le coeur
    # identitaire mesure sur le corpus, pas une consideration secondaire
    # de production a reléguer en fin de liste.
    parts.append(tempo_phrase(stats['tempo_bpm']['mean']))
    parts.append(meter_phrase(stats['meter_guess']['distribution']))
    parts.append(syncopation_phrase(stats['syncopation_ratio']['mean']))
    parts.append(density_phrase(stats['onset_density_per_sec']['mean']))
    parts.append(entropy_phrase(stats['rhythmic_entropy']['mean']))

    # Accords/tonalite SAUTES si l'instrumentation verifiee dit qu'il n'y a
    # pas d'harmonie traditionnelle - les inclure quand meme contredisait
    # frontalement "no melodic instruments" quelques mots plus tot (bug
    # trouve sur le premier essai bend-skin, qui brouillait le modele).
    if not info.get('no_harmony'):
        mode_desc = mode_phrase(stats['dominant_chord_mode']['distribution'])
        if mode_desc:
            parts.append(mode_desc)

    parts.append(brightness_phrase(stats['spectral_centroid_hz']['mean']))
    parts.append(dynamics_phrase(stats['crest_factor_db']['mean']))

    # stereo_width delibetement exclu : sur ce corpus il reflete des rips
    # YouTube mono/quasi-mono d'enregistrements anciens, pas une
    # caracteristique reelle du style - l'inclure biaiserait le prompt
    # vers "toujours generer en mono", ce qui n'a aucun sens musical.

    parts.append('instrumental, no vocals')

    return ', '.join(parts)


def main():
    if len(sys.argv) < 2:
        print('Usage: python scripts/style-dna-to-prompt.py <style-dna.json>', file=sys.stderr)
        sys.exit(1)

    with open(sys.argv[1], 'r', encoding='utf-8') as f:
        dna = json.load(f)

    prompt = build_prompt(dna)

    print(f"\nStyle : {dna['style']} (corpus de {dna['corpus_size']} morceaux)\n")
    print('Prompt genere :\n')
    print(prompt)

    out_path = sys.argv[1].replace('-style-dna.json', '-prompt.txt')
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(prompt)
    print(f'\nSauvegarde : {out_path}', file=sys.stderr)


if __name__ == '__main__':
    main()
