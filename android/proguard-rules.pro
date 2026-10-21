# Consumer R8/ProGuard rules for @pocketpalai/react-native-speech (consumerProguardFiles).

# JNI binds these by name. PhononNative exists only with RNSpeech_phononEnabled=true.
-keep class com.pocketpalai.speech.phonon.PhononNative { native <methods>; }

-keepclasseswithmembernames class com.pocketpalai.speech.NativeDict { native <methods>; }
