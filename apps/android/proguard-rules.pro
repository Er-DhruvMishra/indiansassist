# libwebrtc calls back into Java through JNI: keep its classes and native-facing members.
-keep class org.webrtc.** { *; }
-dontwarn org.webrtc.**
# kotlinx.serialization generated serializers.
-keepattributes *Annotation*, InnerClasses
-keepclassmembers class com.indiansassist.desk.** { *** Companion; }
-keepclasseswithmembers class com.indiansassist.desk.** { kotlinx.serialization.KSerializer serializer(...); }
# Tink optional dependencies.
-dontwarn com.google.errorprone.annotations.**
-dontwarn javax.annotation.**
-dontwarn com.google.api.client.**
-dontwarn org.joda.time.**
