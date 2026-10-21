import {buildVoices, foldVoiceName, parseVoicesJsonl} from '../voices';

describe('parseVoicesJsonl', () => {
  it('parses catalog lines and drops invalid ones', () => {
    const text = [
      '{"name":"Kauã","filename":"voices/k.safetensors","voice_id":"abc123","language":"pt","description":"Calm","gender":"male"}',
      '',
      '   ',
      '{not json',
      '{"filename":"voices/x.safetensors"}',
      '{"name":""}',
      '{"name":"Zoey","filename":"voices/z.safetensors","language":3}',
      'null',
    ].join('\r\n');
    expect(parseVoicesJsonl(text)).toEqual([
      {
        name: 'Kauã',
        filename: 'voices/k.safetensors',
        voice_id: 'abc123',
        language: 'pt',
        description: 'Calm',
        gender: 'male',
      },
      {
        name: 'Zoey',
        filename: 'voices/z.safetensors',
        voice_id: undefined,
        language: undefined,
        description: undefined,
        gender: undefined,
      },
    ]);
  });
});

describe('buildVoices', () => {
  const catalog = parseVoicesJsonl(
    [
      '{"name":"Kauã","filename":"k","voice_id":"abc123","language":"pt","gender":"male","description":"Calm"}',
      '{"name":"Zoey","filename":"z","voice_id":"zz9"}',
    ].join('\n'),
  );

  it('matches by folded name or voice_id, keeping native order', () => {
    expect(buildVoices(['zz9', 'kaua', 'Other'], catalog, 'en')).toEqual([
      {id: 'zz9', name: 'Zoey', language: 'en'},
      {
        id: 'kaua',
        name: 'Kauã',
        language: 'pt',
        gender: 'male',
        description: 'Calm',
      },
      {id: 'Other', name: 'Other', language: 'en'},
    ]);
  });

  it('omits language when neither catalog nor fallback has one', () => {
    expect(buildVoices(['Other'], [])).toEqual([{id: 'Other', name: 'Other'}]);
  });

  it('foldVoiceName strips case and accents', () => {
    expect(foldVoiceName('Kauã')).toBe('kaua');
    expect(foldVoiceName('ÉLODIE')).toBe('elodie');
  });
});
