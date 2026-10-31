# Playwright's image ships Node, git (which the Canvas repository needs) and
# Chromium with its system libraries, for the render check. Its version must
# match the exact `playwright` version in package.json.
FROM mcr.microsoft.com/playwright:v1.64.1-noble
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY starter-canvas ./starter-canvas
ENV DATA_DIR=/data HOST=0.0.0.0 CONSOLE_PORT=3000 CANVAS_PORT=3001
EXPOSE 3000 3001
CMD ["node", "src/main.ts"]
