import {createRStyle} from 'react-native-full-responsive';

export const gs = createRStyle({
  flex: {
    flex: 1,
  },
  disabled: {
    opacity: 0.35,
  },
  button: {
    flex: 1,
    height: '44rs',
    borderRadius: '4rs',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  buttonText: {
    fontSize: '13rs',
    fontWeight: '700',
    fontFamily: 'Courier',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  title: {
    fontSize: '18rs',
    fontWeight: '700',
    marginBottom: '10rs',
    textAlign: 'center',
  },
  paragraph: {
    fontSize: '14rs',
    lineHeight: '22rs',
  },
  p10: {
    padding: '10rs',
  },
  row: {
    columnGap: '8rs',
    flexDirection: 'row',
  },
});
