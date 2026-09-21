# ==============================================================================
# Frontend Dockerfile — Multi-Stage Build (Vite + Nginx Alpine)
# ==============================================================================

# Stage 1: Build — Install deps and produce static build output
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files first for Docker layer caching
COPY package.json package-lock.json* ./

# Install all dependencies
RUN npm ci

# Copy source code and config
COPY . .

# RES-907: Sentry — sürüm/örnekleme/DSN derleme anında pakete gömülür (DSN tarayıcıda zaten kamusaldır; olaylar same-origin tünelden gider).
# SENTRY_AUTH_TOKEN ARG/ENV DEĞİL, BuildKit secret'tır (imaj katmanlarında/history'de görünmez). Token yoksa yükleme atlanır.
ARG VITE_SENTRY_DSN=""
ARG VITE_SENTRY_SAMPLE_RATE="1"
ARG VITE_APP_VERSION="dev"
ARG SENTRY_ORG=""
ARG SENTRY_PROJECT=""
ARG SENTRY_URL=""
ENV VITE_SENTRY_DSN=$VITE_SENTRY_DSN VITE_SENTRY_SAMPLE_RATE=$VITE_SENTRY_SAMPLE_RATE VITE_APP_VERSION=$VITE_APP_VERSION \
    SENTRY_ORG=$SENTRY_ORG SENTRY_PROJECT=$SENTRY_PROJECT SENTRY_URL=$SENTRY_URL

# Build the Vite React app → produces dist/ directory. Source map'ler (hidden) Sentry'ye yüklenip silinir; yüklenmediyse
# (token yok) yine de imaja GİRMEZ — sunulan pakette .map bulunmaz.
RUN --mount=type=secret,id=sentry_auth_token,required=false \
    SENTRY_AUTH_TOKEN="$(cat /run/secrets/sentry_auth_token 2>/dev/null || true)" npm run build \
    && find dist -name '*.map' -delete

# ==============================================================================
# Stage 2: Production — Serve static files with Nginx
# ==============================================================================
FROM nginx:1.27-alpine AS runner

# Baz imajın paketleri yayımlandığı günkü hâliyle kalıyordu: Trivy bu imajda
# düzeltmesi YAYIMLANMIŞ 36 HIGH/CRITICAL buldu (OpenSSL CVE-2026-31789
# CRITICAL dahil — internete bakan sunucu). backend/Dockerfile ile aynı çözüm:
# derleme anında yamalı OS paketlerine yükselt. Aynı katmanda eski dosyaları
# temizle ki imaj büyümesin.
RUN apk upgrade --no-cache \
    && rm -rf /usr/share/nginx/html/* /etc/nginx/conf.d/default.conf

# Copy custom Nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy built static assets from builder stage
COPY --from=builder /app/dist /usr/share/nginx/html

# Nginx runs on port 80 by default
EXPOSE 80

# Health check
# "localhost" burada kasıtlı olarak YOK: bu Alpine nginx görüntüsünde nginx
# yalnızca IPv4 (0.0.0.0:80) dinliyor, ama container içindeki wget "localhost"u
# önce IPv6 ([::1]) olarak çözüyor ve "connection refused" ile başarısız
# oluyor — healthcheck'i konteyner gerçekte sağlıklı yanıt verirken bile
# sürekli UNHEALTHY gösteriyordu (bkz. proje geçmişi, OPS-1102 sırasında
# tespit edildi). 127.0.0.1 açıkça IPv4 istediği için bu belirsizliği ortadan
# kaldırıyor.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:80/ || exit 1

# Start Nginx in foreground
CMD ["nginx", "-g", "daemon off;"]
