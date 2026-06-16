FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Bake the sentence-embedding model into the image so production loads it from
# disk (no runtime download). Runs before NODE_ENV=production so the fetch is
# allowed to reach the model hub at build time.
RUN node scripts/fetch-model.mjs

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# data/ (SQLite + audio) lives on a mounted volume in production
CMD ["node", "server.js"]
