FROM node:26-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci
COPY . .
# Public https origin baked into link previews (set in fly.toml [build.args]).
ARG AUX_PUBLIC_ORIGIN=""
ENV AUX_PUBLIC_ORIGIN=${AUX_PUBLIC_ORIGIN}
RUN npm run gate && npm run build && npm prune --omit=dev

FROM node:26-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0 AUX_DB_FILE=/data/aux.sqlite AUX_ANALYTICS_FILE=/data/analytics.ndjson AUX_TRUST_PROXY=1
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist-app ./apps/server/dist-app
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:8787/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "apps/server/dist-app/index.js"]
