# NurseAid Android BLE App Architecture

This repository contains the architecture and core BLE handling logic for integrating the Jointcorp 2208 SDK (v3.0) into a modern Android Kotlin application.

## Architecture Highlights
- **Coroutines & StateFlow**: Modern asynchronous state management for the UI.
- **Serial Command Queue**: `BleCommandSender` uses a `Mutex` to ensure commands are executed sequentially, avoiding concurrency bugs in the underlying SDK.
- **Callback Normalization**: `BleResultNormalizer` handles the inconsistencies in the SDK's callback map keys (`DataType` vs `dataType`).
- **Safe Pagination**: `HistorySyncCoordinator` handles the recursive `mode=2` fetching safely based on the `dataEnd` flag.

## How to Build & Run
1. Obtain the actual Vendor SDK (`.jar` or `.aar`) provided by Jointcorp.
2. Place the SDK into `app/libs/` directory.
3. Delete the `app/src/main/java/com/softsquare/nurseaid/stub/` folder (which contains the mock classes).
4. Update your `build.gradle` to import the `.jar/.aar`.
5. Open this folder in **Android Studio** and click **Sync Project with Gradle Files**.

## Checkpoints for Real Device Testing
- **Health Measurement Types**: The SDK docs list `type=2` for both Heart and Blood Oxygen. You **MUST** test on a real device to determine the correct type for SpO2 (it might be `3` or `4`).
- **Sleep Details**: The method `GetDetailSleepDataWithMode` is listed twice in the docs for both Sleep and Steps. Check the actual SDK JAR to find the correct method name for Steps (likely `GetDetailStepDataWithMode`).
- **Timeouts**: If the watch does not respond to a command, the Mutex in `BleCommandSender` will timeout after 5 seconds to prevent the app from freezing.
