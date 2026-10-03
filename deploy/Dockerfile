FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm install --no-save tsx
COPY src ./src
COPY tsconfig.json ./
VOLUME /app/data
CMD ["npx", "tsx", "src/index.ts"]
