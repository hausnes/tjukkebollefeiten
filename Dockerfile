# Eitt lite image med Node og appen. Fungerer på både Intel/AMD (amd64) og ARM (arm64).
# Ingen native avhengigheiter: SQLite er innebygd i Node (node:sqlite).
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/tjukkebolle.db \
    TRUST_PROXY=1

# su-exec: entrypoint-et startar som root berre for å rette eigarskap på /data, og byter så til «node».
RUN apk add --no-cache su-exec

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY src ./src
COPY scripts ./scripts
COPY views ./views
COPY public ./public
COPY docker/docker-entrypoint.sh /usr/local/bin/
COPY docker/invitasjon docker/importer /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh /usr/local/bin/invitasjon /usr/local/bin/importer \
    && mkdir -p /data && chown node:node /data

VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD wget -qO- "http://127.0.0.1:${PORT}/api/helse" > /dev/null || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
