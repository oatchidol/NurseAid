package com.softsquare.nurseaid.sync

import com.softsquare.nurseaid.stub.BleSDK

enum class HistoryType {
    TOTAL_ACTIVITY, STEP_DETAIL, SLEEP, DYNAMIC_HR, STATIC_HR
}

class HistorySyncCoordinator {
    private var currentType: HistoryType? = null
    private var currentCursor: String = "2024-01-01 00:00:00"

    fun startSync(type: HistoryType, fromDate: String) {
        currentType = type
        currentCursor = fromDate
        sendReadCommand(type, 1, fromDate) // mode = 1 (start from date)
    }

    fun onHistoryCallback(type: HistoryType, dataEnd: Boolean, lastRecordDate: String) {
        if (type != currentType) return
        currentCursor = lastRecordDate

        if (!dataEnd) {
            // mode = 2 (continue reading)
            sendReadCommand(type, 2, currentCursor)
        } else {
            currentType = null
            // Mark sync complete in Repository
        }
    }

    private fun sendReadCommand(type: HistoryType, mode: Int, date: String) {
        when (type) {
            HistoryType.TOTAL_ACTIVITY -> BleSDK.GetTotalActivityDataWithMode(mode, date)
            // Route other types...
            else -> {}
        }
    }
}
