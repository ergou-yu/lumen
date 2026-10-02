FROM node:22-alpine
WORKDIR /app
COPY --chown=node:node . .
RUN mkdir -p /data && chown node:node /data
USER node
ENV LUMEN_HOST=0.0.0.0 LUMEN_DATA_DIR=/data LUMEN_NO_OPEN=1 PORT=8787
EXPOSE 8787
CMD ["node", "server.js"]
