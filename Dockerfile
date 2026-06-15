FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
COPY ui/package*.json ./ui/
RUN npm ci
RUN cd ui && npm ci

# Copy source
COPY . .

# Build UI
RUN cd ui && npm run build

# Verify typecheck passes
RUN npx tsc --noEmit

# Production image
FROM node:20-alpine

WORKDIR /app

# Install curl for healthcheck + tsx for TypeScript runtime
RUN apk add --no-cache curl

# Copy from builder
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/tsconfig.json ./
COPY --from=builder /app/ui/dist ./ui/dist
COPY --from=builder /app/data ./data
COPY --from=builder /app/.env.example ./.env

# Expose API port
EXPOSE 3456

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:3456/api/status || exit 1

# Use tsx for TypeScript runtime (imports use .ts extensions)
CMD ["npx", "tsx", "src/index.ts"]