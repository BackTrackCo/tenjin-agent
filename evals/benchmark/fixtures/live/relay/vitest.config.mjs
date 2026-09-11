export default {
  test: {
    include: ['tests/**/*.test.mjs'],
    reporters: ['default', ['./scripts/ran-marker.mjs', { task: 'relay' }]],
    setupFiles: ['./.bench1/cases.setup.mjs'],
    cache: false,
  },
};
