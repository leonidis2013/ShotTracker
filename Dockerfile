# ShotTracker: injectable medication tracker
FROM node:22-alpine

ENV NODE_ENV=production \
    DATA_DIR=/data \
    HTTPS_PORT=8443

# openssl makes the self-signed certificate for the https port, tzdata makes TZ work
RUN apk add --no-cache openssl tzdata

WORKDIR /app
COPY package.json server.js ./
COPY public ./public

# the database, certificate and encryption key are kept in /data (a named volume, so they survive updates)
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8443

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('https').get({host:'127.0.0.1',port:process.env.HTTPS_PORT||8443,path:'/api/health',rejectUnauthorized:false},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
