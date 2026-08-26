FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV PORT=7860
EXPOSE 7860

HEALTHCHECK --interval=60s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:7860/api/status >/dev/null 2>&1 || exit 1

CMD ["node", "src/server.js"]
