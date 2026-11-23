# Frame video downloader — Node + yt-dlp + FFmpeg in one image.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    NO_BROWSER=1 \
    BIND=0.0.0.0 \
    ALLOW_PUBLIC=1 \
    FRAME_DOWNLOADER_DATA_DIR=/tmp/frame-data

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      -o /usr/local/bin/yt-dlp \
 && chmod 755 /usr/local/bin/yt-dlp \
 && mkdir -p /tmp/frame-data \
 && chown -R node:node /tmp/frame-data

WORKDIR /app
COPY --chown=node:node . .

USER node
EXPOSE 10120
CMD ["node", "server.js"]
