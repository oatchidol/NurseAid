package com.softsquare.nurseaid.ble

import com.softsquare.nurseaid.stub.BleConnectionListener
import com.softsquare.nurseaid.stub.BleManager
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

enum class ConnectionState {
    DISCONNECTED, CONNECTING, CONNECTED, RECONNECTING, FAILED, BLUETOOTH_OFF
}

class BleConnectionManager {
    private val _connectionState = MutableStateFlow(ConnectionState.DISCONNECTED)
    val connectionState: StateFlow<ConnectionState> = _connectionState

    fun connect(address: String) {
        _connectionState.value = ConnectionState.CONNECTING
        BleManager.instance.connectDevice(address, true, object : BleConnectionListener {
            override fun BleStatus(status: Int, newState: Int) {}
            
            override fun ConnectionSucceeded() {
                _connectionState.value = ConnectionState.CONNECTED
            }

            override fun Connecting() {
                _connectionState.value = ConnectionState.CONNECTING
            }

            override fun ConnectionFailed() {
                _connectionState.value = ConnectionState.FAILED
            }

            override fun OnReconnect() {
                _connectionState.value = ConnectionState.RECONNECTING
            }

            override fun BluetoothSwitchIsTurnedOff() {
                _connectionState.value = ConnectionState.BLUETOOTH_OFF
            }
        })
    }

    fun disconnect() {
        BleManager.instance.disconnectDevice()
        _connectionState.value = ConnectionState.DISCONNECTED
    }
}
