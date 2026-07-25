package com.aslzodiy3.AloTaxiDriver

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap

class OverlayModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String {
        return "OverlayModule"
    }

    @ReactMethod
    fun canDrawOverlays(promise: Promise) {
        try {
            val context: Context = reactApplicationContext
            val result = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                Settings.canDrawOverlays(context)
            } else {
                true
            }
            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("OVERLAY_CHECK_ERROR", e)
        }
    }

    @ReactMethod
    fun requestOverlayPermission(promise: Promise) {
        try {
            val activity: Activity? = reactApplicationContext.currentActivity
            if (activity == null) {
                promise.reject("NO_ACTIVITY", "Faol activity topilmadi")
                return
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                val intent = Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:" + reactApplicationContext.packageName)
                )
                activity.startActivity(intent)
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("OVERLAY_REQUEST_ERROR", e)
        }
    }

    @ReactMethod
    fun showOrderOverlay(orderData: ReadableMap, promise: Promise) {
        try {
            val context: Context = reactApplicationContext
            val serviceIntent = Intent(context, OrderOverlayService::class.java)

            serviceIntent.putExtra("orderId", orderData.getString("orderId") ?: "")
            serviceIntent.putExtra("price", orderData.getString("price") ?: "0")
            serviceIntent.putExtra("fromAddress", orderData.getString("fromAddress") ?: "")
            serviceIntent.putExtra("toAddress", orderData.getString("toAddress") ?: "")
            serviceIntent.putExtra("distanceKm", orderData.getString("distanceKm") ?: "0")
            serviceIntent.putExtra("tariffName", orderData.getString("tariffName") ?: "Standart")
            serviceIntent.putExtra("customerName", orderData.getString("customerName") ?: "")
            serviceIntent.putExtra("customerPhone", orderData.getString("customerPhone") ?: "")

            context.startService(serviceIntent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("SHOW_OVERLAY_ERROR", e)
        }
    }
}