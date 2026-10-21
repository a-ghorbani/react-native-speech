const path = require('path');

module.exports = {
  preset: '@react-native/jest-preset',
  // Metro resolves the library at runtime; jest needs a path even to mock it.
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
