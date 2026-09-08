export default {
  test: {
    include: ['tests/**/*.test.mjs', 'unrelated/**/*.test.mjs'],
    reporters: ['default', ['./scripts/ran-marker.mjs', { task: 'budget' }]],
    cache: false,
  },
};
