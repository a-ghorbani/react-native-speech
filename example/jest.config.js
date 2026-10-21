const path = require('path');

module.exports = {
  preset: '@react-native/jest-preset',
  // The library resolves through Metro's monorepo config at runtime; tests
  // mock it, but jest still needs a path to resolve the mocked module.
  moduleNameMapper: {
    '^@pocketpalai/react-native-speech$': path.join(
      __dirname,
      '..',
      'src',
      'index.tsx',
    ),
  },
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@dr.pogodin)/)',
  ],
  testPathIgnorePatterns: ['/node_modules/', '/android/', '/ios/'],
};
