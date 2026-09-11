export default {
  test: {
    include: ['tests/**/*.test.ts'],
    reporters: ['default', ['./scripts/ran-marker.mjs', { task: 'alias' }]],
    setupFiles: ['./.bench1/cases.setup.mjs'],
    cache: false,
  },
};
