# Multi-stage build for phone-terminal backend + phone app
# Serves both the API/WebSocket relay AND the phone web app from one container

# --- Stage 1: Build phone app (static files) ---
FROM node:20-alpine AS phone-build
WORKDIR /app
COPY package.json package-lock.json ./
COPY phone-app/package.json phone-app/
RUN npm ci --workspace=phone-app
COPY phone-app/ phone-app/
COPY tsconfig.base.json ./
RUN npm run build --workspace=phone-app

# --- Stage 2: Build backend ---
FROM node:20-alpine AS backend-build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
RUN npm ci --workspace=backend
COPY backend/ backend/
COPY tsconfig.base.json ./
RUN cd backend && npx tsc

# --- Stage 3: Production runtime ---
FROM node:20-alpine AS runtime
WORKDIR /app

# Install production deps only
COPY package.json package-lock.json ./
COPY backend/package.json backend/
RUN npm ci --workspace=backend --omit=dev

# Copy compiled backend
COPY --from=backend-build /app/backend/dist backend/dist

# Copy built phone app static files
COPY --from=phone-build /app/phone-app/dist phone-app/dist

# No secrets in the image — they come from fly secrets
ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1

CMD ["node", "backend/dist/server.js"]
