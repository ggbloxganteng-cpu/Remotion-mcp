FROM node:22-bookworm-slim

# Library sistem yang dibutuhkan Chromium milik Remotion
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libnss3 libdbus-1-3 libatk1.0-0 libgbm-dev libasound2 \
    libxrandr2 libxkbcommon-dev libxfixes3 libxcomposite1 libxdamage1 \
    libatk-bridge2.0-0 libpango-1.0-0 libcairo2 libcups2 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Server MCP
COPY package*.json tsconfig.json ./
RUN npm install
COPY src ./src
RUN npm run build

# Proyek Remotion yang mau dirender: taruh tiap proyek di projects/<nama>/
COPY projects ./projects
RUN for d in projects/*/; do if [ -f "$d/package.json" ]; then (cd "$d" && npm install); fi; done

ENV MCP_TRANSPORT=http
ENV REMOTION_GL=angle

CMD ["node", "dist/index.js"]
