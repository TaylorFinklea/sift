FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production PORT=3000 SIFT_DB_PATH=/data/sift.sqlite
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/shared ./shared
COPY --from=build --chown=node:node /app/dist/client ./dist/client
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
VOLUME ["/data"]
CMD ["node", "server/index.js"]
