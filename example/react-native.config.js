const path = require('path');
const pkg = require('../package.json');

// Until phonon.lock.json pins published binaries the Phonon add-on fails
// native builds, so it is linked only with RN_SPEECH_PHONON=1; otherwise its
// JS reports not-compiled.
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
