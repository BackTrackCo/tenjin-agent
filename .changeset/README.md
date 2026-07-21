# Changesets

This directory is managed by [Changesets](https://github.com/changesets/changesets).

Add a changeset in the same PR as any change that should ship:

```sh
pnpm changeset
```

Pick the bump type and write a summary; commit the generated `.md`. The release
workflow (`.github/workflows/release.yml`) consumes these to open a version PR
and then publish to npm. See the Release section of the top-level `README.md`.
