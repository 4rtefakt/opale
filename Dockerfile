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
# setup.sh installe MSAL, Tabler Icons, xterm et Chart.js depuis npm en
# s'appuyant sur front/package-lock.json — versions exactes et empreintes
# d'intégrité vérifiées. Stage séparé pour garder npm et bash hors de l'image
# finale.
#
# Même image de base que le runtime : npm y est déjà présent, et cela évite de
# suivre deux distributions.
FROM node:22-alpine AS frontvendor
RUN apk add --no-cache bash
WORKDIR /src
COPY setup.sh ./
COPY front/ ./front/
RUN chmod +x setup.sh && ./setup.sh && rm -rf front/node_modules

# ─── Stage 2 : runtime API ──────────────────────────────────────────────────
# node:22 — Node 20 est en fin de vie depuis avril 2026 et ne reçoit plus de
# correctifs de sécurité.
FROM node:22-alpine AS runtime
WORKDIR /app

# `npm ci` avec le lockfile, PAS `npm install` avec le seul package.json :
# toutes les dépendances sont déclarées en plages larges (^5, ^8…), donc
# `npm install` résolvait un arbre potentiellement différent de celui testé
# en CI. Une version malveillante publiée sur une dépendance transitive
# entrait alors dans l'image sans qu'aucun test ne l'ait vue.
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

# Le processus ne tourne PAS en root. Ce conteneur détient simultanément la
# clé de signature des binaires agent, la clé de déchiffrement LAPS, la clé
# SSH d'accès au parc et le secret Entra : une exécution de code non
# privilégiée y est nettement moins exploitable qu'une exécution root.
# L'utilisateur `node` (uid 1000) est fourni par l'image de base.
RUN chown -R node:node /app
USER node

EXPOSE 3010

# Sonde applicative : vérifie que l'API répond ET que la base est joignable
# (cf. modules/core/routes/health.js).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3010)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "index.js"]
