const path = require('path');
const pkg = require('../package.json');

// The Phonon add-on fails native builds until phonon.lock.json has published binaries, so the
// example links it natively only with RN_SPEECH_PHONON=1 (its JS then reports not-compiled).
const phonon =
  process.env.RN_SPEECH_PHONON === '1'
    ? {}
    : {
        '@pocketpalai/react-native-speech-phonon': {
          platforms: {android: null, ios: null},
        },
      };

module.exports = {
  project: {
    ios: {
      automaticPodsInstallation: true,
    },
  },
  dependencies: {
    [pkg.name]: {
      root: path.join(__dirname, '..'),
      platforms: {
        // Codegen script incorrectly fails without this
        // So we explicitly specify the platforms with empty object
        ios: {},
        android: {},
      },
    },
    ...phonon,
  },
};
