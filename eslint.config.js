// ESLint flat config (ESLint 9+). Run with `npm run lint`.
module.exports = [
  { ignores: ['node_modules/**', 'audit-logs/**', 'exports/**'] },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        module: 'writable',
        require: 'readonly',
        __dirname: 'readonly',
        fetch: 'readonly',
        setImmediate: 'readonly',
        setInterval: 'readonly',
        setTimeout: 'readonly',
        URLSearchParams: 'readonly'
      }
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': 'warn',
      eqeqeq: ['warn', 'smart']
    }
  }
];
