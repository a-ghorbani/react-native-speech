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
    '^@pocketpalai/react-native-speech/engine-sdk$': path.join(
      __dirname,
      '..',
      'src',
      'engine-sdk.ts',
    ),
    '^@pocketpalai/react-native-speech-phonon$': path.join(
      __dirname,
      '..',
      'packages',
      'react-native-speech-phonon',
      'src',
      'index.ts',
    ),
  },
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@dr.pogodin)/)',
  ],
  testPathIgnorePatterns: ['/node_modules/', '/android/', '/ios/'],
};
