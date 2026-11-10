import Speech from '@pocketpalai/react-native-speech';
import {PhononEngine} from '@pocketpalai/react-native-speech-phonon';
// Opt-in Mandarin for Kokoro's zf_/zm_ voices.
import '@pocketpalai/react-native-speech/zh';

Speech.registerEngine(new PhononEngine());
