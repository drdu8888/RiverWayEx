FROM node:22-slim

WORKDIR /app
COPY . .

# Poll responses live here. Mount a persistent disk/volume at /app/data (or set DATA_DIR)
# if you want them to survive restarts and redeploys. The SURVEY file is never written here:
# it is uploaded through the Analysis page and held in memory only.
VOLUME ["/app/data"]

EXPOSE 3000
CMD ["node", "server.js"]
