FROM node:20-slim AS build
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm install
COPY backend/ ./
RUN npm run build

FROM node:20-slim
WORKDIR /app/backend
ENV NODE_ENV=production
COPY backend/package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/backend/dist ./dist
COPY --from=build /app/backend/migrations ./migrations
COPY frontend/ /app/frontend/
RUN mkdir -p ./storage/uploads
EXPOSE 4000
CMD ["node", "dist/server.js"]
