import {useState, useEffect, useRef} from 'react';

export function useTypewriter(
  text: string,
  speed: number = 30,
  enabled: boolean = true,
): string {
  const [displayed, setDisplayed] = useState('');
  const prevText = useRef('');

  useEffect(() => {
    if (!enabled) {
      setDisplayed(text);
      return;
    }

    if (text === prevText.current) {
      return;
    }
    prevText.current = text;
    setDisplayed('');

    let i = 0;
    const timer = setInterval(() => {
      i++;
      setDisplayed(text.slice(0, i));
      if (i >= text.length) {
        clearInterval(timer);
      }
    }, speed);

    return () => clearInterval(timer);
  }, [text, speed, enabled]);

  return displayed;
}
