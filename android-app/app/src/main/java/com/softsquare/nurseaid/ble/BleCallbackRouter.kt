package com.softsquare.nurseaid.ble

import com.softsquare.nurseaid.stub.DataListener

class BleCallbackRouter : DataListener {
    override fun dataCallback(maps: java.util.Map<String, Any>?) {
        if (maps == null) return
        val rawMap = maps as Map<String, Any>
        val result = BleResultNormalizer.normalize(rawMap)

        when (result.dataType) {
            4 -> parseDeviceInfo(result.data)
            19 -> parseRealtimeActivity(result.data)
            24 -> parseTotalActivity(result.data, result.dataEnd)
            // TODO: Route all other cases as specified in the docs.
            else -> {
                // Log unhandled cases
                println("Unhandled DataType: ${result.dataType}, Data: ${result.raw}")
            }
        }
    }

    private fun parseDeviceInfo(data: Any?) {
        // Parse into DeviceInfo model
    }

    private fun parseRealtimeActivity(data: Any?) {
        // Broadcast real-time updates
    }

    private fun parseTotalActivity(data: Any?, dataEnd: Boolean) {
        // Send to HistorySyncCoordinator
    }
}
