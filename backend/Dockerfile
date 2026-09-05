# ==============================================================================
# Backend Dockerfile — Multi-Stage Build (Node.js 20 Alpine)
# ==============================================================================

# Stage 1: Build — Compile TypeScript to standalone JS bundle
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies for native modules (argon2)
RUN apk add --no-cache python3 make g++

# Copy package files first for Docker layer caching
COPY package.json package-lock.json* ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY . .

# Build standalone server bundle → dist/server.js
RUN npm run build

# ==============================================================================
# Stage 2: Production Runner — Minimal, Secure, Non-Root
# ==============================================================================
FROM node:20-alpine AS runner

# Pull in patched Alpine packages (closes upstream libcrypto3/libssl3 CVEs
# fixed since the node:20-alpine base layer was published) before installing
# tini for proper PID 1 init & signal reaping (SIGTERM, SIGINT) and build
# tools for native module installation.
#
# OPS-1101: python3/make/g++ (bir C/C++ derleyici zinciri, onlarca-yüzlerce
# MB) önceden AYRI bir `RUN apk add ...` komutunda kuruluyor, npm ci'dan
# SONRA AYRI bir `RUN apk del ...` komutuyla siliniyordu. Docker katmanlı bir
# dosya sistemi kullanır — bir SONRAKİ katmanda silinen dosyalar, imajın
# kendisinden ASLA çıkmaz, yalnızca bir "whiteout" işaretiyle gizlenir; ÖNCEKİ
# katmandaki veri hâlâ diskte durur ve imaj boyutuna DAHİL olmaya devam eder.
# Bu, imajın (ölçülen) 871MB'a şişmesinin ana nedeniydi (hedef: <150MB).
# Kurulum + kullanım + silme AYNI RUN komutunda (tek katman) olmalı ki silme
# GERÇEKTEN boyutu küçültsün.
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=5000

# Copy package files for production dependency installation
COPY package.json package-lock.json* ./

RUN apk update && apk upgrade --no-cache \
    && apk add --no-cache tini wget python3 make g++ \
    && npm ci --omit=dev \
    && npm cache clean --force \
    && apk del python3 make g++

# Remove the bundled global npm CLI itself — it drags in its own large tree of
# transitive dependencies (tar, minimatch, cross-spawn, sigstore, pacote...)
# that scanners flag (was the source of ~20 HIGH/CRITICAL CVEs) but that are
# never invoked at runtime: CMD below runs `node` directly, never `npm`/`npx`.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

# OPS-1101: `RUN chown -R node:node /app` (önceki hali) node_modules gibi
# BÜYÜK, alt katmanlardan gelen bir ağacın sahipliğini değiştiriyordu —
# overlay dosya sistemi bunu yaparken dosyaları YENİ bir katmana KOPYALAR
# ("copy-up"), bu da ~137MB'lık node_modules'ü neredeyse İKİNCİ kez (+71.7MB)
# imaja eklemişti. Uygulama runtime'da /app'e hiçbir şey YAZMIYOR (durum
# Postgres/Redis'te, loglar stdout'a) — bu yüzden npm ci'nin root olarak
# ürettiği (varsayılan olarak dünya-okunabilir izinli) node_modules'a
# dokunmaya hiç gerek yok; yalnızca aşağıdaki KÜÇÜK dosyalar `--chown` ile
# doğrudan node kullanıcısına ait olarak kopyalanıyor (ayrı bir RUN/katman
# gerektirmez, COPY zaten hedef sahipliği ilk yazımda ayarlar).
COPY --from=builder --chown=node:node /app/dist/server.cjs ./dist/server.cjs
COPY --chown=node:node src/db/schema.sql ./src/db/schema.sql
COPY --chown=node:node src/routes ./src/routes

# Switch to unprivileged non-root user
USER node

EXPOSE 5000

# Health check — hit the /api/v1/health endpoint every 30s
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:5000/api/v1/health || exit 1

# Use tini as init process to handle zombie reaping and signals gracefully
ENTRYPOINT ["/sbin/tini", "--"]

# Start production server
CMD ["node", "dist/server.cjs"]
