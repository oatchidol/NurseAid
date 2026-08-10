package com.softsquare.nurseaid.model

data class DeviceTime(val time: String)
data class UserProfile(val age: Int, val height: Int, val weight: Int, val stepLength: Int, val sex: Int)
data class DeviceInfo(val handleSign: Int, val wristOn: Int, val screenBrightness: Int, val baseHeartRate: Int)
data class ActivityRecord(val date: String, val goal: Int, val distance: Float, val step: Int, val exerciseTime: Int, val calories: Float)
data class StepDetail(val date: String, val distance: Float, val calories: Float, val arraySteps: List<Int>)
data class SleepRecord(val date: String, val sleepUnitLength: Int, val arraySleepQuality: List<Int>)
data class DynamicHeartRate(val date: String, val arrayDynamicHR: List<Int>)
data class StaticHeartRate(val date: String, val onceHeartValue: Int)
data class HrvRecord(val date: String, val heartValue: Int, val hrvValue: Int, val highPressure: Int, val lowPressure: Int)
data class HealthMeasurement(val heartRate: Int, val bloodOxygen: Int, val hrv: Int)
data class BloodPressureCalibration(val highPressure: Int, val lowPressure: Int)
