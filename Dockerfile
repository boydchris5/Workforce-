FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
# Mount persistent storage here so the database survives redeploys.
ENV DB_FILE=/data/workforce.db
VOLUME ["/data"]
EXPOSE 3000
CMD ["npm", "start"]
