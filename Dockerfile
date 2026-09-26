# Opale — image Docker tout-en-un pour self-hosters.
#
# Cette image contient l'API + le frontend statique vendorisé. Elle est
# utilisée par docker-compose.example.yml. Pour les déploiements qui
# montent front/ en volume et co-localisent agent-go, voir api/Dockerfile
# (image API-only, plus légère).
#
# Build : docker build -t opale:latest .
# Run   : voir docker-compose.example.yml

# ─── Stage 1 : vendorise les dépendances front ──────────────────────────────
# setup.sh télécharge MSAL, Tabler Icons, etc. dans front/. On le fait dans
# un stage séparé pour ne pas polluer l'image finale avec curl/bash.
FROM alpine:3.20 AS frontvendor
RUN apk add --no-cache bash curl ca-certificates
WORKDIR /src
COPY setup.sh ./
COPY front/ ./front/
RUN chmod +x setup.sh && ./setup.sh

# ─── Stage 2 : runtime API ──────────────────────────────────────────────────
# Node 22 LTS (Node 20 est en fin de vie depuis avril 2026). Garder la même
# majeure que la CI (.github/workflows/ci.yml) et que `engines` (package.json).
FROM node:22-alpine AS runtime
WORKDIR /app

# Dépendances API de prod (pas de devDependencies), installées depuis le
# lockfile : `npm ci` installe exactement les versions testées en CI et
# échoue si package.json et package-lock.json divergent (au lieu de
# résoudre les dernières versions au moment du build).
COPY api/package.json api/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Code de l'API.
COPY api/ ./

# Frontend avec libs vendorisées par le stage 1.
COPY --from=frontvendor /src/front/ ./front/

# Clés publiques agent-go embarquées dans l'image (utilisées au build des
# binaires agent côté serveur de prod, et nécessaires pour /api/agent/binary
# si vous régénérez les binaires depuis ce conteneur).
# Les clés PRIVÉES (signing.key, laps.key) et le binaire compilé
# (agent-go/dist/) doivent être fournis au runtime via volume — JAMAIS
# dans l'image. Voir docker-compose.example.yml.
COPY agent-go/keys/signing.pub ./agent-go/keys/signing.pub
COPY agent-go/keys/laps.pub    ./agent-go/keys/laps.pub

EXPOSE 3010
CMD ["node", "index.js"]
