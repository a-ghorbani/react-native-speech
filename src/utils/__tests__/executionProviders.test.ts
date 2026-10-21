const mockPlatform = {OS: 'android'};
let mockConstants: {primaryAbi?: string} | null = null;
jest.mock('react-native', () => ({
  get Platform() {
    return mockPlatform;
  },
  TurboModuleRegistry: {
    get: () => (mockConstants ? {getConstants: () => mockConstants} : null),
  },
}));

import {getDefaultExecutionProviders} from '../executionProviders';

describe('getDefaultExecutionProviders', () => {
  beforeEach(() => {
    mockPlatform.OS = 'android';
    mockConstants = null;
  });

  test.each(['x86_64', 'x86'])('Android %s: CPU only', abi => {
    mockConstants = {primaryAbi: abi};
    expect(getDefaultExecutionProviders()).toEqual(['cpu']);
  });

  test('Android arm64: xnnpack then CPU', () => {
    mockConstants = {primaryAbi: 'arm64-v8a'};
    expect(getDefaultExecutionProviders()).toEqual(['xnnpack', 'cpu']);
  });

  test('Android with unknown ABI keeps the xnnpack default', () => {
    expect(getDefaultExecutionProviders()).toEqual(['xnnpack', 'cpu']);
    mockConstants = {};
    expect(getDefaultExecutionProviders()).toEqual(['xnnpack', 'cpu']);
  });

  test('iOS: CoreML, xnnpack, CPU', () => {
    mockPlatform.OS = 'ios';
    mockConstants = {primaryAbi: 'x86_64'};
    const eps = getDefaultExecutionProviders();
    expect(eps[0]).toEqual(expect.objectContaining({name: 'coreml'}));
    expect(eps.slice(1)).toEqual(['xnnpack', 'cpu']);
  });
});
