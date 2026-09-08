export default {
  test: {
    include: ['tests/**/*.test.mjs'],
    reporters: ['default', ['./scripts/ran-marker.mjs', { task: 'money' }]],
    cache: false,
  },
};
