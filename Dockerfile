FROM node:20-bookworm-slim

RUN corepack enable && corepack prepare pnpm@10.34.5 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json web/package.json
COPY config config
COPY agent agent
COPY gateway gateway
COPY providers providers
COPY scripts scripts
COPY web web

RUN pnpm install --frozen-lockfile && pnpm --filter @rova/web build

ENV NODE_ENV=production
ENV DEMO_STALE=1

CMD ["node", "scripts/demo.mjs"]
