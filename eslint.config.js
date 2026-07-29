const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: [
      '.expo/**',
      'android/**',
      'ios/**',
      'functions/lib/**',
    ],
  },
  {
    // The regression runner and its unit suites run under Node, not Metro.
    files: ['scripts/**/*.js', 'tests/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        console: 'readonly',
        module: 'writable',
        process: 'readonly',
        require: 'readonly',
      },
    },
  },
]);
