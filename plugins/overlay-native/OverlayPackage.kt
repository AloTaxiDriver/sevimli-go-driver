package com.aslzodiy3.AloTaxiDriver

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * OverlayPackage — OverlayModule'ni React Native'ga "tanitadi".
 * Bu fayl bo'lmasa, JS tomondan NativeModules.OverlayModule
 * topilmaydi.
 */
class OverlayPackage : ReactPackage {
    override fun createNativeModules(
        reactContext: ReactApplicationContext
    ): List<NativeModule> {
        return listOf(OverlayModule(reactContext))
    }

    override fun createViewManagers(
        reactContext: ReactApplicationContext
    ): List<ViewManager<*, *>> {
        return emptyList()
    }
}