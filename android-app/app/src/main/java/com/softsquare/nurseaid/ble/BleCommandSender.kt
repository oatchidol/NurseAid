package com.softsquare.nurseaid.ble

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.delay
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout

class BleCommandSender {
    // Serial queue to prevent overlapping commands
    private val mutex = Mutex()

    /**
     * Enqueues a BLE command safely with a timeout and retry logic.
     */
    suspend fun sendCommand(
        commandBlock: () -> Unit,
        timeoutMs: Long = 5000L,
        retries: Int = 1
    ): Boolean {
        return mutex.withLock {
            var attempt = 0
            while (attempt <= retries) {
                try {
                    withTimeout(timeoutMs) {
                        commandBlock()
                        // In a real implementation, you would wait for a callback/suspendCoroutine here.
                        // For fire-and-forget commands, this just delays slightly to let the BLE stack breathe.
                        delay(200) 
                    }
                    return@withLock true
                } catch (e: TimeoutCancellationException) {
                    attempt++
                    if (attempt > retries) {
                        return@withLock false
                    }
                    delay(1000) // Backoff before retry
                }
            }
            false
        }
    }
}
