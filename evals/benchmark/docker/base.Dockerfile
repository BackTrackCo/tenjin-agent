# The Bench-2 base image: node, pnpm and Claude Code by exact version on a base
# pinned by digest, plus the Tenjin CLI this checkout builds. Nothing here is
# resolved at run time, so the image is the reproducibility claim a lockfile
# used to make.
#
# Built by `python3 -m evals.benchmark.images build`, which supplies every ARG
# from `images.recipe()`; the versions are not defaulted here, because a
# default is a pin nobody states. The context is staged by `images.build_base`
# rather than being the docker directory, because the CLI package has to be
# copyable and it does not live here.
ARG BASE_IMAGE
ARG BASE_DIGEST
FROM ${BASE_IMAGE}@${BASE_DIGEST}

ARG PNPM_VERSION
ARG AGENT_PACKAGE
ARG AGENT_VERSION
ARG AGENT_COMMAND
ARG CA_CERTIFICATES_VERSION

# Native CLIs use the system trust store; the slim Node base does not carry it.
RUN apt-get update -qq \
  && apt-get install -y --no-install-recommends "ca-certificates=${CA_CERTIFICATES_VERSION}" \
  && rm -rf /var/lib/apt/lists/*

# Legacy Landlock requires the protected names to exist in every writable root.
# Root ownership also makes these metadata directories unwritable by trial UIDs.
RUN mkdir -p /tmp/.git /tmp/.codex /tmp/.agents

# One registry conversation, and the npm cache dropped: a trial never installs
# anything, so the cache is dead weight in every image built from this one. The
# CLI is a layer of its own below, so a CLI change does not re-run this.
RUN npm install -g \
      "pnpm@${PNPM_VERSION}" \
      "${AGENT_PACKAGE}@${AGENT_VERSION}" \
  && npm cache clean --force \
  && pnpm --version \
  && "${AGENT_COMMAND}" --version

# The `tenjin` an agent runs in a Bash tool, from THIS CHECKOUT: `package.json`
# and every path its `files` names, staged by `images.stage_cli`. A pinned
# release cannot redden this lane, and a version string does not identify a
# build, so `images.recipe` hashes the staged package and a CLI change is a new
# base tag. `npm pack` runs here so the image installs what a user would
# install, which fails the build if `files` ever stops shipping the product;
# `--ignore-scripts` keeps a lifecycle hook out of the image.
COPY cli /opt/tenjin-cli
RUN npm pack /opt/tenjin-cli --ignore-scripts --pack-destination /tmp \
  && npm install -g --ignore-scripts /tmp/tenjin-cli-*.tgz \
  && rm -f /tmp/*.tgz \
  && npm cache clean --force \
  && tenjin --version \
  && tenjin daemon --help > /dev/null

# The entrypoint: it starts the trial's daemon inside this container and then
# execs the keepalive Harbor's compose file hands it, so pid 1 is what
# `docker compose down` signals. The agent is exec'd in separately, and
# `bench2-trial --stop` ends the daemon before the host reads `loop.db`.
COPY trial.mjs /opt/bench2/trial.mjs
RUN printf '#!/bin/sh\nexec node /opt/bench2/trial.mjs "$@"\n' > /usr/local/bin/bench2-trial \
  && chmod 0755 /usr/local/bin/bench2-trial

# A trial runs as the host's uid against bind mounts, so nothing may depend on
# a writable image home; the trial's own HOME is a mount and is passed in.
ENV npm_config_update_notifier=false \
    PNPM_HOME=/opt/bench2/pnpm \
    DO_NOT_TRACK=1

ENTRYPOINT ["/usr/local/bin/bench2-trial"]
