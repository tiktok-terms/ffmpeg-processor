# Node.js + FFmpeg
FROM node:20-slim

# Устанавливаем FFmpeg + шрифты с кириллицей (DejaVu)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ffmpeg \
       fonts-dejavu-core \
       fonts-dejavu-extra \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Ставим зависимости
COPY package.json ./
RUN npm install --omit=dev

# Копируем код
COPY server.js ./

# Railway сам передаёт PORT через переменную окружения
EXPOSE 3000

CMD ["npm", "start"]
