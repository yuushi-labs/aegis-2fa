import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

/**
 * 署名。
 *
 * リリース APK は「同じ鍵で署名されていないと上書きインストールできない」ため、
 * CI のランナーごとに作られる使い捨ての debug 鍵ではなく、リポジトリに置いた
 * 固定の配布用鍵で署名する。この鍵は配布 ID（公開情報）であり、秘密情報ではない
 * （詳しくは docs/SECURITY.md と android/keystore/README.md）。
 *
 * リポジトリのシークレットに ANDROID_KEYSTORE_BASE64 ほかが設定されていれば、
 * そちらを優先する（ワークフローがファイルへ展開してから渡す）。
 */
val distributionKeystore = System.getenv("AEGIS_KEYSTORE_PATH")?.let { file(it) }
    ?: rootProject.file("keystore/aegis-debug.keystore")
val signingPropertiesFile = rootProject.file("keystore/signing.properties")
val signingProperties = Properties().apply {
    if (signingPropertiesFile.exists()) {
        signingPropertiesFile.inputStream().use { load(it) }
    }
}

android {
    namespace = "com.yuushilabs.aegis"
    compileSdk = 35
    buildToolsVersion = "34.0.0"

    defaultConfig {
        applicationId = "com.yuushilabs.aegis"
        minSdk = 26
        targetSdk = 35
        // Web 版 1.1.0 と揃える。
        versionCode = 2
        versionName = "1.1.0"
        resourceConfigurations += listOf("ja", "en")
        vectorDrawables { useSupportLibrary = true }
    }

    signingConfigs {
        getByName("debug") {
            if (distributionKeystore.exists()) {
                storeFile = distributionKeystore
                storePassword = System.getenv("AEGIS_KEYSTORE_PASSWORD")
                    ?: signingProperties.getProperty("storePassword", "android")
                keyAlias = System.getenv("AEGIS_KEY_ALIAS")
                    ?: signingProperties.getProperty("keyAlias", "androiddebugkey")
                keyPassword = System.getenv("AEGIS_KEY_PASSWORD")
                    ?: signingProperties.getProperty("keyPassword", "android")
            }
        }
        create("distribution") {
            if (distributionKeystore.exists()) {
                storeFile = distributionKeystore
                storePassword = System.getenv("AEGIS_KEYSTORE_PASSWORD")
                    ?: signingProperties.getProperty("storePassword", "android")
                keyAlias = System.getenv("AEGIS_KEY_ALIAS")
                    ?: signingProperties.getProperty("keyAlias", "androiddebugkey")
                keyPassword = System.getenv("AEGIS_KEY_PASSWORD")
                    ?: signingProperties.getProperty("keyPassword", "android")
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        release {
            isMinifyEnabled = false
            isShrinkResources = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            signingConfig =
                if (distributionKeystore.exists()) signingConfigs.getByName("distribution")
                else signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }

    lint {
        // リリースビルド時の lintVital は、CI の lintDebug と同じ検査を二重に走らせるうえ
        // メモリを大量に使う（この環境では JVM が落ちた）。検査は lintDebug で行う。
        checkReleaseBuilds = false
        abortOnError = true
        warningsAsErrors = false
        // 依存ライブラリ側の指摘や、この端末専用アプリでは該当しない翻訳の指摘は落とさない。
        disable += setOf("GradleDependency", "AndroidGradlePluginVersion", "OldTargetApi", "MissingTranslation", "UnusedResources", "NewerVersionAvailable")
    }

    packaging {
        resources {
            excludes += setOf("/META-INF/{AL2.0,LGPL2.1}", "/META-INF/DEPENDENCIES", "META-INF/LICENSE*", "META-INF/NOTICE*")
        }
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)

    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-core")
    implementation("androidx.fragment:fragment:1.8.5")
    implementation("androidx.biometric:biometric:1.1.0")

    // QR: カメラはカメラX、デコードと生成は ZXing（ML Kit のような外部送信も Google Play 依存も無い）。
    implementation("androidx.camera:camera-camera2:1.4.1")
    implementation("androidx.camera:camera-lifecycle:1.4.1")
    implementation("androidx.camera:camera-view:1.4.1")
    implementation("com.google.zxing:core:3.5.3")

    implementation("com.google.code.gson:gson:2.10.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")

    debugImplementation("androidx.compose.ui:ui-tooling")
}
