package com.softsquare.nurseaid.ble

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BleResultNormalizerTest {

    @Test
    fun testKeyNormalization() {
        val map1 = mapOf("dataType" to 24, "dicData" to "hello", "dataEnd" to true)
        val res1 = BleResultNormalizer.normalize(map1)
        assertEquals(24, res1.dataType)
        assertEquals(true, res1.dataEnd)
        assertEquals("hello", res1.data)

        val map2 = mapOf("DataType" to "25", "Data" to "world", "DataEnd" to "false")
        val res2 = BleResultNormalizer.normalize(map2)
        assertEquals(25, res2.dataType)
        assertEquals(false, res2.dataEnd)
        assertEquals("world", res2.data)
    }

    @Test
    fun testArrayParsing() {
        val inputStr = " 1 23  456 0 "
        val list = BleResultNormalizer.parseIntegerArray(inputStr)
        assertEquals(listOf(1, 23, 456, 0), list)
    }
}
