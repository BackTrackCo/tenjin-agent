// The workspace convention: tests run through pnpm. A runner reached any
// other way has no pnpm agent in its environment and is refused here.
const agent = process.env.npm_config_user_agent ?? '';
if (!agent.startsWith('pnpm/')) {
  throw new Error("this repository's tests run through pnpm; see the repository convention");
}

export default {
  test: {
    include: ['tests/**/*.test.mjs', 'unrelated/**/*.test.mjs'],
    reporters: ['default', ['./scripts/ran-marker.mjs', { task: 'slug' }]],
    cache: false,
  },
};
