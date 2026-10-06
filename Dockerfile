# Etapa 1: compila o TypeScript
FROM node:22-bookworm-slim AS build
# better-sqlite3 compila nativo quando não há binário pronto
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json && npm prune --omit=dev

# Etapa 2: só o necessário para rodar
FROM node:22-bookworm-slim
ENV NODE_ENV=production DADOS_DIR=/app/data CONFIG_DIR=/app/config PAINEL_HOST=0.0.0.0 PAINEL_PORTA=3100
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY config ./config
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3100
HEALTHCHECK --interval=60s --timeout=5s --start-period=60s CMD node -e "fetch('http://127.0.0.1:3100/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
