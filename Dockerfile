# CineVault TV backend — zero npm dependencies, so the image only needs Node.
# The service binds to $PORT on 0.0.0.0 (see backend/config/config.js).

FROM node:20-alpine

WORKDIR /app

# Whole repository: the backend also serves the static frontend as a
# same-origin fallback. backend/.env is excluded by .dockerignore.
COPY . .

ENV NODE_ENV=production
ENV PORT=8000
EXPOSE 8000

# Unprivileged user; the app writes nothing to disk.
RUN addgroup -S cvtv && adduser -S cvtv -G cvtv && chown -R cvtv:cvtv /app
USER cvtv

CMD ["node", "backend/server.js"]
