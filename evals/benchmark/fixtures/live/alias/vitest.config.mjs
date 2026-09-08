export default {
  test: {
    include: ['tests/**/*.test.ts'],
    reporters: ['default', ['./scripts/ran-marker.mjs', { task: 'alias' }]],
    cache: false,
  },
};
