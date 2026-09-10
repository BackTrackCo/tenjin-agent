export default {
  test: {
    include: ['tests/**/*.test.mjs'],
    reporters: ['default', ['./scripts/ran-marker.mjs', { task: 'upstream' }]],
    setupFiles: ['./.bench1/cases.setup.mjs'],
    cache: false,
  },
};
