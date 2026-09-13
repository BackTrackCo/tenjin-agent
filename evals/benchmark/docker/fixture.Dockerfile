# One image per fixture, built from the base with the fixture directory as the
# build context, so a fixture layer holds that task's own files and nothing
# else. There is one such file rather than eight identical ones: the per-task
# difference is the context and the labels, which `images.py` supplies.
#
# `pnpm install` runs here, at build time, with a network. That is why a
# fixture commits a `package.json` with its test runner pinned and no lockfile,
# no `.npmrc`, and no vendored archive: the installed tree is the image, and
# `images.json` plus the image's own labels name the build a run used.
ARG BASE_TAG
FROM ${BASE_TAG}

COPY . /opt/fixture
WORKDIR /opt/fixture

# How a package manager installs is the image's business, not the fixture's:
# pnpm 11 exits non-zero when a dependency's build script is unapproved, and
# vitest's only one is esbuild's, which links a binary the platform package
# already ships. The build proves that rather than assuming it, by running both
# executables; a broken toolchain fails here instead of inside a paid trial.
#
# A fixture without a package.json (the plumbing smoke's repository) installs
# nothing and still gets an image, so every live trial runs the same way.
RUN if [ -f package.json ]; then \
      printf '\nstrictDepBuilds: false\n' >> pnpm-workspace.yaml \
      && pnpm install \
      && pnpm exec vitest --version \
      && pnpm exec esbuild --version; \
    else \
      mkdir -p /opt/fixture/node_modules; \
    fi
