# node:22 — Node 20 est en fin de vie depuis avril 2026.
FROM node:22-alpine
WORKDIR /app
# `npm ci` + lockfile : reproductible et aligné sur ce que teste la CI.
COPY api/package.json api/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY api/ ./
COPY front/ ./front/
# agent-go/ contient la clé publique de signature.
# Le binaire (dist/), agent-version.txt et la clé privée (keys/signing.key)
# sont fournis au runtime via volume — JAMAIS dans l'image.
COPY agent-go/keys/signing.pub ./agent-go/keys/signing.pub
# Pas de root : ce conteneur détient la clé de signature agent, la clé LAPS,
# la clé SSH du parc et le secret Entra.
RUN chown -R node:node /app
USER node

EXPOSE 3010

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3010)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "index.js"]
