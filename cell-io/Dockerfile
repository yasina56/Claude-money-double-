# CELL.IO game server (serves the built client too).
# Build:  docker build -t cell-io cell-io
# Run:    docker run -p 3001:3001 -e PORT=3001 cell-io

# Base image is overridable, e.g. --build-arg NODE_IMAGE=public.ecr.aws/docker/library/node:22-alpine
# if Docker Hub rate-limits you.
ARG NODE_IMAGE=node:22-alpine

# --- build stage: install everything and bundle the client
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- runtime stage: production dependencies + built client + server/shared sources
FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist/client ./dist/client
COPY shared ./shared
COPY server ./server
COPY tsconfig.json ./
USER node
# Render (and most hosts) inject PORT; 3001 is the local default.
ENV PORT=3001
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- "http://127.0.0.1:${PORT}/health" > /dev/null || exit 1
CMD ["node", "--import", "tsx", "server/index.ts"]
