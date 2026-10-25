FROM node:22-slim AS build
WORKDIR /app
COPY package*.json tsconfig*.json ./
RUN npm ci
COPY src ./src
COPY data ./data
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY data ./data
EXPOSE 8080
CMD ["node", "dist/index.js"]
