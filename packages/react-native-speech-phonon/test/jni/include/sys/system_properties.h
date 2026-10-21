// Host stand-in for <sys/system_properties.h>; every property reads as unset, like a stock
// phone's ro.dalvik.vm.native.bridge.
#pragma once
#define PROP_VALUE_MAX 92
#ifdef __cplusplus
extern "C" {
#endif
int __system_property_get(const char* name, char* value);
#ifdef __cplusplus
}
#endif
