import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    // Capacitor mirrors the already-built/minified web bundle into these
    // generated native projects. Lint the source once, before it is copied.
    ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', 'android/**', 'ios/**'],
  },
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      // Board-gated TODOs only — see docs/TODO.md rule 1 (owner condition #4).
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='TODO']",
          message: 'Anonymous TODO forbidden.',
        },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
