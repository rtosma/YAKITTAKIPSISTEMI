# ==============================================================================
# Stage 1: Build Stage (Dependencies & Standalone Server Bundle)
# ==============================================================================
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install dependencies (including devDependencies needed for build)
RUN npm ci

# Copy source files
COPY . .

# Build standalone server bundle (outputs dist/server.js)
RUN npm run build:server

# ==============================================================================
# Stage 2: Production Runner Stage (Minimal, Secure, Non-Root)
# ==============================================================================
FROM node:20-alpine AS runner

# Install tini for proper init process & signal reaping (SIGTERM, SIGINT)
RUN apk add --no-cache tini wget

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=5000

# Copy package files for production dependency installation
COPY package.json package-lock.json ./

# Install production dependencies only (such as argon2 binary bindings)
RUN npm ci --only=production && npm cache clean --force

# Copy built server bundle from builder stage
COPY --from=builder /app/dist/server.js ./dist/server.js

# Change ownership of /app directory to non-root node user
RUN chown -R node:node /app

# Switch to unprivileged non-root user
USER node

EXPOSE 5000

# Health check endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:5000/api/v1/health || exit 1

# Use tini as init process to handle signals gracefully
ENTRYPOINT ["/sbin/tini", "--"]

# Start production server
CMD ["node", "dist/server.js"]
