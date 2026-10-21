import Speech from '@pocketpalai/react-native-speech';
import {PhononEngine} from '@pocketpalai/react-native-speech-phonon';

Speech.registerEngine(new PhononEngine());
