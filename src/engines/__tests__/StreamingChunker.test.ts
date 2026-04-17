import {StreamingChunker} from '../StreamingChunker';

async function flushMicrotasks() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe('StreamingChunker', () => {
  test('yields a chunk once a sentence boundary appears', async () => {
    const chunker = new StreamingChunker();
    chunker.append('Hello world. ');
    const chunk = await chunker.getNextChunk();
    expect(chunk).not.toBeNull();
    expect(chunk!.text).toBe('Hello world. ');
    expect(chunk!.startIndex).toBe(0);
    expect(chunk!.endIndex).toBe(13);
  });

  test('blocks until a sentence boundary arrives', async () => {
    const chunker = new StreamingChunker();
    chunker.append('Hello');

    let resolved = false;
    const chunkPromise = chunker.getNextChunk().then(c => {
      resolved = true;
      return c;
    });

    await flushMicrotasks();
    expect(resolved).toBe(false);

    chunker.append(' world. ');
    const chunk = await chunkPromise;
    expect(resolved).toBe(true);
    expect(chunk!.text).toBe('Hello world. ');
  });

  test('groups multiple sentences up to maxChunkSize', async () => {
    const chunker = new StreamingChunker(100);
    chunker.append('One. Two. Three. ');
    const chunk = await chunker.getNextChunk();
    expect(chunk!.text).toBe('One. Two. Three. ');
  });

  test('splits when buffer exceeds maxChunkSize', async () => {
    const chunker = new StreamingChunker(15);
    chunker.append('Short. Longer sentence here. ');

    const chunk1 = await chunker.getNextChunk();
    expect(chunk1!.text).toBe('Short. ');
    expect(chunk1!.startIndex).toBe(0);

    const chunk2 = await chunker.getNextChunk();
    expect(chunk2!.text).toBe('Longer sentence here. ');
    expect(chunk2!.startIndex).toBe(7);
  });

  test('finalize drains remaining text without sentence boundary', async () => {
    const chunker = new StreamingChunker();
    chunker.append('no sentence end');
    chunker.finalize();
    const chunk = await chunker.getNextChunk();
    expect(chunk!.text).toBe('no sentence end');
    expect(chunk!.startIndex).toBe(0);
    expect(chunk!.endIndex).toBe(15);

    const done = await chunker.getNextChunk();
    expect(done).toBeNull();
  });

  test('finalize with nothing buffered returns null immediately', async () => {
    const chunker = new StreamingChunker();
    chunker.finalize();
    const chunk = await chunker.getNextChunk();
    expect(chunk).toBeNull();
  });

  test('cancel resolves blocked getNextChunk with null', async () => {
    const chunker = new StreamingChunker();
    chunker.append('waiting');

    const chunkPromise = chunker.getNextChunk();
    chunker.cancel();

    const chunk = await chunkPromise;
    expect(chunk).toBeNull();
  });

  test('append after finalize is ignored', async () => {
    const chunker = new StreamingChunker();
    chunker.append('Hello. ');
    chunker.finalize();
    chunker.append('Should be ignored. ');

    const chunk = await chunker.getNextChunk();
    expect(chunk!.text).toBe('Hello. ');

    const done = await chunker.getNextChunk();
    expect(done).toBeNull();
  });

  test('absolute offsets are monotonically increasing across chunks', async () => {
    const chunker = new StreamingChunker(20);
    chunker.append('First. Second. Third. ');
    chunker.finalize();

    const chunks = [];
    let chunk = await chunker.getNextChunk();
    while (chunk) {
      chunks.push(chunk);
      chunk = await chunker.getNextChunk();
    }

    expect(chunks.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.startIndex).toBe(chunks[i - 1]!.endIndex);
    }
  });

  test('CJK: flushes on 。 without trailing whitespace', async () => {
    const chunker = new StreamingChunker();
    chunker.append('你好。');
    const chunk = await chunker.getNextChunk();
    expect(chunk!.text).toBe('你好。');
  });

  test('CJK: mixed ASCII and CJK punctuation', async () => {
    const chunker = new StreamingChunker(100);
    chunker.append('Hello! 你好。再見。');
    const chunk = await chunker.getNextChunk();
    expect(chunk!.text).toBe('Hello! 你好。再見。');
  });

  test('totalAppended tracks cumulative input size', async () => {
    const chunker = new StreamingChunker();
    expect(chunker.totalAppended).toBe(0);
    chunker.append('Hello. ');
    expect(chunker.totalAppended).toBe(7);
    await chunker.getNextChunk();
    expect(chunker.totalAppended).toBe(7);
    chunker.append('World. ');
    expect(chunker.totalAppended).toBe(14);
  });

  test('tryPeek returns undefined when waiting, null when done', async () => {
    const chunker = new StreamingChunker();
    expect(chunker.tryPeek()).toBeUndefined();

    chunker.append('Hello. ');
    const peeked = chunker.tryPeek();
    expect(peeked).not.toBeNull();
    expect(peeked).not.toBeUndefined();
    expect(peeked!.text).toBe('Hello. ');

    chunker.finalize();
    await chunker.getNextChunk();
    expect(chunker.tryPeek()).toBeNull();
  });
});
