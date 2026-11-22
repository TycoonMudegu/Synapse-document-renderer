FROM node:24-trixie-slim
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright PORT=8080
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npx playwright install --with-deps chromium \
    && apt-get update \
    && apt-get install -y --no-install-recommends libreoffice-writer fonts-crosextra-carlito fonts-crosextra-caladea fonts-dejavu-core fonts-liberation2 fonts-opensymbol \
    && rm -rf /var/lib/apt/lists/*
COPY src ./src
COPY test ./test
COPY fonts /usr/local/share/fonts/synapse
RUN fc-cache -f
USER node
EXPOSE 8080
CMD ["node", "src/server.mjs"]
