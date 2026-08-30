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

# Build the Vite React app → produces dist/ directory
RUN npm run build

# ==============================================================================
# Stage 2: Production — Serve static files with Nginx
# ==============================================================================
FROM nginx:1.27-alpine AS runner

# Remove default Nginx config and static files
RUN rm -rf /usr/share/nginx/html/* /etc/nginx/conf.d/default.conf

# Copy custom Nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy built static assets from builder stage
COPY --from=builder /app/dist /usr/share/nginx/html

# Nginx runs on port 80 by default
EXPOSE 80

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:80/ || exit 1

# Start Nginx in foreground
CMD ["nginx", "-g", "daemon off;"]
