FROM node:24-bookworm-slim

# Python + Parselmouth (Praat) : seule dependance locale reelle, utilisee
# uniquement par scripts/autotune.py (correction de hauteur karaoke).
# Demucs/Stable Audio/Basic Pitch passent tous par des API distantes
# (Fal.ai, Replicate) - pas de calcul ML local lourd a heberger.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir --break-system-packages praat-parselmouth

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Dossiers de donnees persistantes (montes en volume Coolify) - crees ici
# au cas ou le volume est vide au premier demarrage.
RUN mkdir -p data uploads karaoke-sessions creations-storage melody-cache catalogue-audio downloads

ENV PORT=3300
EXPOSE 3300

CMD ["node", "src/server.js"]
