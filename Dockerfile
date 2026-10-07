FROM node:22-alpine

# Install FFmpeg for automated video and image compression
RUN apk add --no-cache ffmpeg

WORKDIR /app

# Install production dependencies first (layer caching)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source files
COPY . .

# Ensure writable application directories exist and keep the runtime unprivileged.
RUN mkdir -p data uploads backups \
  && chown -R node:node /app

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/health || exit 1

CMD ["node", "server.js"]
