import {NativeModules} from 'react-native';

interface BenchmarkModule {
  getMemoryStats(): Promise<{
    nativeHeapAllocatedMB: number;
    nativeHeapFreeMB: number;
    totalMemoryMB: number;
    availableMemoryMB: number;
  }>;
  beginTraceInterval(name: string): void;
  endTraceInterval(name: string): void;
  logMarker(message: string): void;
  clearMarkers(): void;
  startMemoryPolling(intervalMs: number): void;
  stopMemoryPolling(): Promise<{
    peakNativeHeapMB: number;
    sampleCount: number;
  }>;
}

const {RNBenchmark} = NativeModules;
export default RNBenchmark as BenchmarkModule;
