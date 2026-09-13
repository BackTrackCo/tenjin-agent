ARG NODE_IMAGE
FROM ${NODE_IMAGE}
ARG PNPM_VERSION
RUN npm install --global pnpm@${PNPM_VERSION}
WORKDIR /opt/task
COPY source/package.json source/pnpm-lock.yaml source/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY source/ ./
COPY oracle.test.ts ./src/bench3-independent.test.ts
COPY vitest.config.mjs /opt/bench3/vitest.config.mjs
# Sources execute only in the later network-free verification container.
