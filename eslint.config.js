import js from '@eslint/js';
import ts from 'typescript-eslint';
import globals from 'globals';

export default ts.config(
  { ignores: ['.output/**', '.wxt/**', 'node_modules/**', 'src/legacy/**', 'test-results/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  { languageOptions: { globals: { ...globals.browser, ...globals.node, chrome: 'readonly', defineBackground: 'readonly', defineContentScript: 'readonly' } }, rules: { '@typescript-eslint/no-explicit-any': 'error' } }
);
