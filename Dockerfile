# syntax=docker/dockerfile:1

# ---- build: 全依存（devDependencies 込み）で SPA とサーバーをビルドする ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
# better-sqlite3 の prebuild が無い環境でもビルドできるようにする（このステージは配布しない）。
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# ---- prod-deps: 本番依存だけを入れる（devDependencies は持ち込まない） ----
FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
# better-sqlite3 はネイティブモジュール。prebuild が使えない環境向けにコンパイラを用意する。
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
# パッケージストアや npm のキャッシュは runtime へコピーしない。
RUN pnpm store prune && rm -rf /root/.cache /root/.npm

# ---- runtime: 本番依存 + ビルド成果物のみ ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/data/zekey.db
RUN groupadd --system --gid 1001 zekey \
  && useradd --system --uid 1001 --gid zekey --create-home zekey \
  && mkdir -p /data && chown zekey:zekey /data
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/package.json ./package.json
# ビルド元の umask に依存せず、非 root ユーザーが読める（ディレクトリは辿れる）ようにする。
RUN chmod -R a+rX dist dist-server node_modules package.json
USER zekey
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist-server/index.js"]
