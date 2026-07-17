import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      // The output contract owns the process streams (stdout = one JSON
      // envelope, stderr = human rendering); console.log would bypass it.
      'no-console': ['error', { allow: ['warn', 'error'] }],
      // TS's compiler already flags undefined identifiers; core no-undef only
      // false-positives on Node globals (process, Buffer, fetch) in a TS file.
      'no-undef': 'off',
    },
  },
];
