import {createRStyle} from 'react-native-full-responsive';

export const gs = createRStyle({
  flex: {
    flex: 1,
  },
  disabled: {
    opacity: 0.5,
  },
  button: {
    flex: 1,
    height: '44rs',
    borderRadius: '10rs',
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: {
    fontSize: '14rs',
    fontWeight: '600',
  },
  title: {
    fontSize: '18rs',
    fontWeight: '700',
    marginBottom: '10rs',
    textAlign: 'center',
  },
  paragraph: {
    fontSize: '15rs',
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
