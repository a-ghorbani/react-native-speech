# Consumer R8/ProGuard rules for @pocketpalai/react-native-speech (consumerProguardFiles).

# Phonon JNI shim (librnspeech_phonon.so) binds these by name. Only present when the library
# is built with RNSpeech_phononEnabled=true; the rule matches nothing otherwise.
-keep class com.pocketpalai.speech.phonon.PhononNative { native <methods>; }

# NativeDict (libnative_dict.so) binds by name too.
-keepclasseswithmembernames class com.pocketpalai.speech.NativeDict { native <methods>; }
