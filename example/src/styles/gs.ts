import {Platform} from 'react-native';
import {createRStyle} from 'react-native-full-responsive';

const mono = Platform.select({ios: 'Menlo', default: 'monospace'});

export const gs = createRStyle({
  flex: {
    flex: 1,
  },
  disabled: {
    opacity: 0.3,
  },
  button: {
    flex: 1,
    height: '44rs',
    borderRadius: 2,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  buttonText: {
    fontSize: '12rs',
    fontWeight: '700',
    fontFamily: mono,
    letterSpacing: 1.5,
  },
  title: {
    fontSize: '18rs',
    fontWeight: '700',
    fontFamily: mono,
    marginBottom: '10rs',
    textAlign: 'center',
  },
  paragraph: {
    fontSize: '13rs',
    lineHeight: '21rs',
    fontFamily: mono,
  },
  p10: {
    padding: '10rs',
  },
  row: {
    columnGap: '8rs',
    flexDirection: 'row',
  },
});
