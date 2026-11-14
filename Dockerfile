FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY src ./src
COPY public ./public
RUN mkdir -p /data && chown node:node /data
USER node
ENV DATA_DIR=/data PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "src/server.js"]
