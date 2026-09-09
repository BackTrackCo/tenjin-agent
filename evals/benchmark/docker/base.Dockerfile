# The Bench-2 base image: node, pnpm, Claude Code, and the Tenjin CLI, each by
# exact version, on a base pinned by digest. Nothing here is resolved at run
# time, so the image is the reproducibility claim a lockfile used to make.
#
# Built by `python3 -m evals.benchmark.images build`, which supplies every ARG
# from `images.recipe()`; the versions are not defaulted here, because a
# default is a pin nobody states.
ARG BASE_IMAGE
ARG BASE_DIGEST
FROM ${BASE_IMAGE}@${BASE_DIGEST}

ARG PNPM_VERSION
ARG CLAUDE_VERSION
ARG TENJIN_VERSION

# One layer, one registry conversation, and the npm cache dropped: a trial
# never installs anything, so the cache is dead weight in every image built
# from this one.
RUN npm install -g \
      "pnpm@${PNPM_VERSION}" \
      "@anthropic-ai/claude-code@${CLAUDE_VERSION}" \
      "tenjin-cli@${TENJIN_VERSION}" \
  && npm cache clean --force \
  && pnpm --version \
  && claude --version \
  && tenjin --version

# The entrypoint: it starts the trial's daemon inside this container, runs the
# agent, stops the daemon, and exits with the agent's code.
COPY trial.mjs /opt/bench2/trial.mjs
RUN printf '#!/bin/sh\nexec node /opt/bench2/trial.mjs "$@"\n' > /usr/local/bin/bench2-trial \
  && chmod 0755 /usr/local/bin/bench2-trial

# A trial runs as the host's uid against bind mounts, so nothing may depend on
# a writable image home; the trial's own HOME is a mount and is passed in.
ENV npm_config_update_notifier=false \
    PNPM_HOME=/opt/bench2/pnpm \
    DO_NOT_TRACK=1

ENTRYPOINT ["/usr/local/bin/bench2-trial"]
