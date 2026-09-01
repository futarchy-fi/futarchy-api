FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV PORT=3031
EXPOSE 3031

CMD ["node", "src/index.js"]
