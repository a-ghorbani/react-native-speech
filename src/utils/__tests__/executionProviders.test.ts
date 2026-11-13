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

  test('iOS: bare CPU, whatever the ABI (#150)', () => {
    mockPlatform.OS = 'ios';
    expect(getDefaultExecutionProviders()).toEqual(['cpu']);
    mockConstants = {primaryAbi: 'arm64-v8a'};
    expect(getDefaultExecutionProviders()).toEqual(['cpu']);
  });
});
