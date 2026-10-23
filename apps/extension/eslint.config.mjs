// Extension lint rules (section 9.5, 12.1): the root config plus no-unsanitized, no eval, and the CDP
// sendCommand restriction (only src/background/debugger-control.ts may call chrome.debugger.sendCommand).
import nounsanitized from 'eslint-plugin-no-unsanitized';
import root from '../../eslint.config.mjs';

export default [
  ...root,
  {
    plugins: { 'no-unsanitized': nounsanitized },
    rules: {
      'no-unsanitized/method': 'error',
      'no-unsanitized/property': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[property.name='sendCommand'][object.property.name='debugger']",
          message: 'Use sendCommand() in src/background/debugger-control.ts (CDP allow-list).',
        },
        { selector: "MemberExpression[property.name='outerHTML']", message: 'outerHTML is banned in the extension.' },
        { selector: "CallExpression[callee.property.name='insertAdjacentHTML']", message: 'insertAdjacentHTML is banned.' },
        { selector: "CallExpression[callee.property.name='createContextualFragment']", message: 'createContextualFragment is banned.' },
      ],
    },
  },
  {
    // The allow-list wrapper itself, and its test (which asserts the mock is never reached), may name the method.
    files: ['src/background/debugger-control.ts', 'test/debugger-control.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "MemberExpression[property.name='outerHTML']", message: 'outerHTML is banned in the extension.' },
      ],
    },
  },
];
