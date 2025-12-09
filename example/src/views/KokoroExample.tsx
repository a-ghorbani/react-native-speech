/**
 * Kokoro TTS Example
 *
 * Demonstrates how to use the Kokoro neural TTS engine with model management
 */

import React from 'react';
import {View, Text, StyleSheet, Alert} from 'react-native';
import Speech, {TTSEngine} from '@mhpdev/react-native-speech';
import Button from '../components/Button';
import {kokoroModelManager} from '../utils/ModelManager';

const KokoroExample: React.FC = () => {
  const [isInitialized, setIsInitialized] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(false);
  const [isSpeaking, setIsSpeaking] = React.useState(false);

  /**
   * Initialize Kokoro engine with bundled models
   *
   * This example assumes you have bundled the Kokoro models with your app.
   * See ModelManager.ts for details on how to bundle models.
   */
  const initializeKokoro = React.useCallback(async () => {
    try {
      setIsLoading(true);

      // Get bundled model configuration
      const config = kokoroModelManager.getBundledModelConfig();

      // Initialize Kokoro engine using unified API
      await Speech.initialize({
        engine: TTSEngine.KOKORO,
        ...config,
        phonemizerType: 'native',
        // phonemizerUrl: 'http://192.168.0.82:3000',
      });

      setIsInitialized(true);
      Alert.alert('Success', 'Kokoro engine initialized!');
    } catch (error) {
      console.error('Failed to initialize Kokoro:', error);
      Alert.alert(
        'Error',
        `Failed to initialize Kokoro: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  /**
   * Speak text using Kokoro
   */
  const speakWithKokoro = React.useCallback(async () => {
    if (!isInitialized) {
      Alert.alert('Error', 'Please initialize Kokoro first');
      return;
    }

    try {
      setIsSpeaking(true);

      // Speak using the unified API
      await Speech.speak(
        'Hello! This is Kokoro neural text to speech.',
        'af_bella', // Voice ID
        {
          speed: 1.0,
          volume: 1.0,
        },
      );

      setIsSpeaking(false);
    } catch (error) {
      console.error('Failed to speak:', error);
      Alert.alert(
        'Error',
        `Failed to speak: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      setIsSpeaking(false);
    }
  }, [isInitialized]);

  /**
   * Get available Kokoro voices
   */
  const showAvailableVoices = React.useCallback(async () => {
    if (!isInitialized) {
      Alert.alert('Error', 'Please initialize Kokoro first');
      return;
    }

    try {
      const voices = await Speech.getVoicesWithMetadata();
      const voiceList = voices.map(v => `${v.name} (${v.id})`).join('\n');
      Alert.alert('Available Voices', voiceList);
    } catch (error) {
      console.error('Failed to get voices:', error);
      Alert.alert(
        'Error',
        `Failed to get voices: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }, [isInitialized]);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Kokoro Neural TTS Example</Text>

      <Text style={styles.description}>
        This example demonstrates how to use the Kokoro neural TTS engine.
        {'\n\n'}
        Note: This requires bundled model files. See ModelManager.ts for
        details.
      </Text>

      <View style={styles.buttonContainer}>
        <Button
          label={isLoading ? 'Initializing...' : 'Initialize Kokoro'}
          onPress={initializeKokoro}
          disabled={isInitialized || isLoading}
        />

        <Button
          label="Show Available Voices"
          onPress={showAvailableVoices}
          disabled={!isInitialized}
        />

        <Button
          label={isSpeaking ? 'Speaking...' : 'Speak with Kokoro'}
          onPress={speakWithKokoro}
          disabled={!isInitialized || isSpeaking}
        />
      </View>

      <View style={styles.statusContainer}>
        <Text style={styles.statusLabel}>Status:</Text>
        <Text style={styles.statusText}>
          {isInitialized ? '✅ Initialized' : '⚠️ Not initialized'}
        </Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 16,
  },
  description: {
    fontSize: 14,
    color: '#666',
    marginBottom: 24,
    lineHeight: 20,
  },
  buttonContainer: {
    gap: 12,
    marginBottom: 24,
  },
  statusContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    backgroundColor: '#f5f5f5',
    borderRadius: 8,
  },
  statusLabel: {
    fontSize: 16,
    fontWeight: '600',
    marginRight: 8,
  },
  statusText: {
    fontSize: 16,
  },
});

export default KokoroExample;
