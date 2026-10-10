FROM node:20-bookworm-slim

RUN corepack enable && corepack prepare pnpm@10.34.5 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY scripts scripts
COPY web web

ENV NODE_ENV=production

CMD ["node", "scripts/serve.mjs"]
