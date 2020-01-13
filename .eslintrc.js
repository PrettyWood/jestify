module.exports = {
  root: true,
  env: {
    node: true,
    es6: true
  },
  extends: [
    'eslint:recommended',
    'plugin:import/errors',
    'plugin:prettier/recommended',
  ],
  rules: {
    camelcase: ['error', { properties: 'never' }],
    eqeqeq: ['error', 'always', { 'null': 'ignore' }],
    'no-console': 'error',
    'no-debugger': 'error',
    'no-var': ['error'],
    'no-unused-vars': [
      'warn',
      {
        varsIgnorePattern: 'should|expect|^_',
      },
    ],
    'object-shorthand': 'off',
    'prefer-const': ['error', { 'destructuring': 'all' }],
    'simple-import-sort/sort': 'error',
    'import/no-unresolved': 'error',
  },
  parserOptions: {
    "ecmaVersion": 2019,
  },
  plugins: ["simple-import-sort"],
};
