# The full Node image already ships git, which the Canvas repository needs.
FROM node:22
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY starter-canvas ./starter-canvas
ENV DATA_DIR=/data HOST=0.0.0.0 CONSOLE_PORT=3000 CANVAS_PORT=3001
EXPOSE 3000 3001
CMD ["node", "src/main.ts"]
