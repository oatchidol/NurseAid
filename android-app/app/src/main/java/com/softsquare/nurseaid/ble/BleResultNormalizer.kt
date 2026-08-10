package com.softsquare.nurseaid.ble

class BleResult {
    var dataType: Int = -1
    var data: Any? = null
    var dataEnd: Boolean = false
    var raw: Map<String, Any> = emptyMap()
}

object BleResultNormalizer {
    fun normalize(rawMap: Map<String, Any>): BleResult {
        val result = BleResult()
        result.raw = rawMap
        
        // Handle dataType / DataType
        val rawType = rawMap["dataType"] ?: rawMap["DataType"]
        if (rawType is Number) {
            result.dataType = rawType.toInt()
        } else if (rawType is String) {
            result.dataType = rawType.toIntOrNull() ?: -1
        }
        
        // Handle dataEnd / DataEnd
        val rawEnd = rawMap["dataEnd"] ?: rawMap["DataEnd"]
        if (rawEnd is Boolean) {
            result.dataEnd = rawEnd
        } else if (rawEnd is String) {
            result.dataEnd = rawEnd.toBoolean()
        }
        
        // Handle dicData / Data
        result.data = rawMap["dicData"] ?: rawMap["Data"]
        
        return result
    }

    /**
     * Parses a space-separated string of numbers into a List of Integers.
     */
    fun parseIntegerArray(input: Any?): List<Int> {
        if (input == null) return emptyList()
        if (input is List<*>) return input.mapNotNull { it?.toString()?.toIntOrNull() }
        val str = input.toString().trim()
        if (str.isEmpty()) return emptyList()
        return str.split(Regex("\\s+")).mapNotNull { it.toIntOrNull() }
    }
}
