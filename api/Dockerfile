# Node 22 LTS : même majeure que la CI et que `engines` (api/package.json).
FROM node:22-alpine
WORKDIR /app
# Dépendances de prod depuis le lockfile (versions testées en CI).
COPY api/package.json api/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY api/ ./
COPY front/ ./front/
# agent-go/ contient la clé publique de signature.
# Le binaire (dist/), agent-version.txt et la clé privée (keys/signing.key)
# sont fournis au runtime via volume — JAMAIS dans l'image.
COPY agent-go/keys/signing.pub ./agent-go/keys/signing.pub
EXPOSE 3010
CMD ["node", "index.js"]
