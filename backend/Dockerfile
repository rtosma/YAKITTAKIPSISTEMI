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
# tools for native module installation
RUN apk update && apk upgrade --no-cache && apk add --no-cache tini wget python3 make g++

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=5000

# Copy package files for production dependency installation
COPY package.json package-lock.json* ./

# Install production dependencies only (argon2 native bindings, pg, etc.)
RUN npm ci --omit=dev && npm cache clean --force

# Clean build dependencies to optimize container image size
RUN apk del python3 make g++

# Remove the bundled global npm CLI itself — it drags in its own large tree of
# transitive dependencies (tar, minimatch, cross-spawn, sigstore, pacote...)
# that scanners flag (was the source of ~20 HIGH/CRITICAL CVEs) but that are
# never invoked at runtime: CMD below runs `node` directly, never `npm`/`npx`.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

# Copy built server bundle from builder stage
COPY --from=builder /app/dist/server.cjs ./dist/server.cjs

# Copy database schema and seed files (needed for init scripts)
COPY src/db/schema.sql ./src/db/schema.sql

# Copy route definitions so swagger-jsdoc can parse OpenAPI comments
COPY src/routes ./src/routes

# Change ownership to non-root 'node' user
RUN chown -R node:node /app

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
