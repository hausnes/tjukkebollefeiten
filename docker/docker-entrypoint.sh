#!/bin/sh
# Startar som root berre for å sikre at «node»-brukaren kan skrive i /data.
# Det trengst fordi ei mappe som er montert frå NAS-en (bind mount) ofte er eigd av ein annan brukar.
set -e

if [ "$(id -u)" = "0" ]; then
    mkdir -p /data
    chown -R node:node /data
    exec su-exec node "$@"
fi

exec "$@"
