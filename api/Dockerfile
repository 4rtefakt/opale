# Node 22 LTS : même majeure que la CI et que `engines` (api/package.json).
FROM node:22-alpine
WORKDIR /app
# Miroir git du parc Linux : `git http-backend` est dans git-daemon sur Alpine,
# `ssh-keygen` (signatures SSH des commits) dans openssh-keygen. Avant les COPY
# du code pour que la couche reste en cache entre deux builds.
RUN apk add --no-cache git git-daemon openssh-keygen
# Dépendances de prod depuis le lockfile (versions testées en CI).
COPY api/package.json api/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY api/ ./
COPY front/ ./front/
# agent-go/ contient la clé publique de signature.
# Le binaire (dist/), agent-version.txt et la clé privée (keys/signing.key)
# sont fournis au runtime via volume — JAMAIS dans l'image.
COPY agent-go/keys/signing.pub ./agent-go/keys/signing.pub
# Utilisateur non-root (uid/gid 1000). Chemins écrits au runtime : les pièces
# jointes (ATTACHMENTS_DIR) et le miroir git (LINUX_GIT_DIR), à node pour
# qu'un volume neuf en hérite. Les fichiers montés doivent être lisibles par
# l'uid/gid 1000 : voir docker-compose.yml.
RUN mkdir -p /app/data/ticket-attachments /app/data/git && chown -R node:node /app/data
USER node
EXPOSE 3010
CMD ["node", "index.js"]
