module.exports = {
  dependency: {
    platforms: {
      android: {
        packageImportPath:
          'import com.pocketpalai.speech.phonon.RNSpeechPhononPackage;',
        packageInstance: 'new RNSpeechPhononPackage()',
      },
      ios: {},
    },
  },
};
