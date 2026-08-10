package com.softsquare.nurseaid.stub

import java.util.Map

// Stubs for the missing Jointcorp SDK
interface DataListener {
    fun dataCallback(maps: Map<String, Any>)
}

interface BleConnectionListener {
    fun BleStatus(status: Int, newState: Int)
    fun ConnectionSucceeded()
    fun Connecting()
    fun ConnectionFailed()
    fun OnReconnect()
    fun BluetoothSwitchIsTurnedOff()
}

object BleManager {
    val instance: BleManager = BleManager()
    fun connectDevice(address: String, autoReconnect: Boolean, listener: BleConnectionListener?) {}
    fun disconnectDevice() {}
}

object BleSDK {
    fun GetDeviceInfo() {}
    fun GetTotalActivityDataWithMode(mode: Int, date: String) {}
    // Add other stubs as needed
}
