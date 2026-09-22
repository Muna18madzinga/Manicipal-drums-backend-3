# Use Node.js 20 LTS
FROM node:20-alpine AS base

# Install dependencies only when needed
FROM base AS deps
WORKDIR /app

# Install production dependencies
COPY package.json package-lock.json ./
RUN npm ci --only=production && npm cache clean --force

# Development stage
FROM base AS development
WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install all dependencies (including dev)
RUN npm ci

# Copy source code
COPY . .

# Create non-root user
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nodejs -u 1001

# Change ownership of the app directory
RUN chown -R nodejs:nodejs /app
USER nodejs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node healthcheck.js

# Start development server
CMD ["npm", "run", "dev"]

# Type-check stage: compiles TS so type regressions fail the image build
# (the production image runs the plain-JS server.js entrypoint, not dist/).
FROM base AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Production stage
FROM base AS production
WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nodejs -u 1001

# Production dependencies only
COPY --from=deps --chown=nodejs:nodejs /app/node_modules ./node_modules

# The runtime entrypoint (server.js) requires the whole source tree plus the
# migration scripts (migrate:render) and healthcheck.js, so copy it in full.
COPY --chown=nodejs:nodejs . .

RUN chown -R nodejs:nodejs /app

# Change to non-root user
USER nodejs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node healthcheck.js

# Start production server
CMD ["node", "server.js"]