# ShotTracker: injectable medication tracker

# The camera barcode reader for browsers without a built-in one (iPhone Safari). It is only a browser
# file served to the page; the server itself has no npm dependencies. If the download fails, the
# build still succeeds and the scan screen falls back to typing or pasting the code.
FROM node:22-alpine AS vendor
WORKDIR /v
COPY test/check-zxing.js ./
RUN mkdir -p out && \
    for v in 0.23.0 0.21.3; do \
      rm -rf node_modules && \
      npm install --no-save --no-audit --no-fund --ignore-scripts @zxing/library@$v >/dev/null 2>&1 && \
      cp node_modules/@zxing/library/umd/index.min.js out/zxing.min.js 2>/dev/null && \
      node check-zxing.js out/zxing.min.js && echo "ZXing $v barcode reader bundled" && break; \
      rm -f out/zxing.min.js; echo "ZXing $v not usable, trying the next"; \
    done; [ -f out/zxing.min.js ] || echo "WARNING: ZXing not bundled; scanning falls back to typed entry"

FROM node:22-alpine

ENV NODE_ENV=production \
    DATA_DIR=/data \
    HTTPS_PORT=8443

# openssl makes the self-signed certificate for the https port, tzdata makes TZ work
RUN apk add --no-cache openssl tzdata

WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public
COPY --from=vendor /v/out/ ./public/vendor/

# the database, certificate, encryption key and backups are kept in /data (a named volume, so they survive updates)
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8443

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('https').get({host:'127.0.0.1',port:process.env.HTTPS_PORT||8443,path:'/api/health',rejectUnauthorized:false},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
