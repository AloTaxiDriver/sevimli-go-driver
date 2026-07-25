package com.aslzodiy3.AloTaxiDriver

import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.net.Uri
import android.os.CountDownTimer
import android.os.IBinder
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.WindowManager
import android.widget.TextView
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

class OrderOverlayService : Service() {

    private var windowManager: WindowManager? = null
    private var overlayView: View? = null
    private var countDownTimer: CountDownTimer? = null
    private var mediaPlayer: MediaPlayer? = null
    private var isAccepted = false  // Qabul qilinganmi — timer onFinish da tekshiriladi

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        removeOverlay()
        isAccepted = false

        val data = intent?.extras
        showOverlay(
            orderId    = data?.getString("orderId")     ?: "",
            price      = data?.getString("price")       ?: "0",
            fromAddress= data?.getString("fromAddress") ?: "",
            toAddress  = data?.getString("toAddress")   ?: "",
            distanceKm = data?.getString("distanceKm")  ?: "0",
            tariffName = data?.getString("tariffName")  ?: "Standart",
            customerName  = data?.getString("customerName")  ?: "Noma'lum mijoz",
            customerPhone = data?.getString("customerPhone") ?: ""
        )
        return START_NOT_STICKY
    }

    private fun showOverlay(
        orderId: String,
        price: String,
        fromAddress: String,
        toAddress: String,
        distanceKm: String,
        tariffName: String,
        customerName: String,
        customerPhone: String
    ) {
        windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        overlayView   = LayoutInflater.from(this).inflate(R.layout.layout_order_overlay, null)

        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT
        )
        params.gravity = Gravity.CENTER
        windowManager?.addView(overlayView, params)
        playRingtone()

        val priceNumber = price.toLongOrNull() ?: 0L
        overlayView?.findViewById<TextView>(R.id.tvOverlayPrice)?.text =
            formatPrice(priceNumber) + " so'm"
        overlayView?.findViewById<TextView>(R.id.tvOverlayTariff)?.text      = tariffName
        overlayView?.findViewById<TextView>(R.id.tvOverlayFromAddress)?.text =
            fromAddress.ifEmpty { "Manzil ko'rsatilmagan" }
        overlayView?.findViewById<TextView>(R.id.tvOverlayToAddress)?.text   =
            toAddress.ifEmpty { "Manzil ko'rsatilmagan" }
        overlayView?.findViewById<TextView>(R.id.tvOverlayCustomerName)?.text  = customerName
        overlayView?.findViewById<TextView>(R.id.tvOverlayCustomerPhone)?.text = customerPhone

        val distance = distanceKm.toDoubleOrNull() ?: 0.0
        if (distance > 0)
            overlayView?.findViewById<TextView>(R.id.tvOverlayDistance)?.text =
                String.format("%.1f km", distance)

        // ── QABUL QILISH ──────────────────────────────────────
        overlayView?.findViewById<View>(R.id.btnOverlayAccept)?.setOnClickListener {
            if (isAccepted) return@setOnClickListener   // ikki marta bosilmasin
            isAccepted = true
            countDownTimer?.cancel()   // ← MUHIM: timer darhol to'xtatiladi
            countDownTimer = null
            stopRingtone()
            removeOverlayView()        // faqat view olib tashlanadi
            stopSelf()
            // MUHIM: eski sendEventToJS + launchApp() o'rniga endi
            // deep link ishlatiladi. sendEventToJS ishonchsiz edi
            // (reactContext EAS Build'da ba'zan null bo'lardi),
            // launchApp() esa orderId'ni umuman uzatmasdi — shuning
            // uchun app/accept.tsx hech qachon ishga tushmasdi. Deep
            // link Android'ning o'z mexanizmi bo'lib, ilova
            // yopiq/fonda bo'lsa ham ishonchli ishlaydi.
            launchAppWithDeepLink(orderId)
        }

        // ── O'TKAZIB YUBORISH ─────────────────────────────────
        overlayView?.findViewById<View>(R.id.btnOverlayDecline)?.setOnClickListener {
            if (isAccepted) return@setOnClickListener
            sendEventToJS("OrderOverlayDecline", orderId)
            removeOverlay()
            stopSelf()
        }

        // ── TAYMER ───────────────────────────────────────────
        val timerView = overlayView?.findViewById<TextView>(R.id.tvOverlayTimer)
        countDownTimer = object : CountDownTimer(15_000, 1000) {
            override fun onTick(millisUntilFinished: Long) {
                timerView?.text = "${millisUntilFinished / 1000}s"
            }
            override fun onFinish() {
                // Agar haydovchi allaqachon qabul qilgan bo'lsa — hech narsa qilmaymiz
                if (isAccepted) return
                sendEventToJS("OrderOverlayDecline", orderId)
                removeOverlay()
                stopSelf()
            }
        }.start()
    }

    /**
     * Faqat WindowManager view'ni olib tashlaydi (timer/ringtone'ga tegmaydi).
     * Qabul qilish tugmasida ishlatiladi — chunki timer allaqachon cancel qilingan.
     */
    private fun removeOverlayView() {
        try {
            if (overlayView != null) windowManager?.removeView(overlayView)
        } catch (_: Exception) {}
        overlayView = null
    }

    /**
     * Timer + ringtone + view — hammasini to'xtatadi.
     * Rad etish va onFinish da ishlatiladi.
     */
    private fun removeOverlay() {
        countDownTimer?.cancel()
        countDownTimer = null
        stopRingtone()
        removeOverlayView()
    }

    /**
     * Qabul qilingan buyurtma uchun deep link orqali ilovani ochadi.
     * app/accept.tsx bu URI'ni qabul qilib, MapScreen'ga
     * acceptOrderId parametrini uzatadi.
     */
    private fun launchAppWithDeepLink(orderId: String) {
        try {
            val intent = Intent(
                Intent.ACTION_VIEW,
                Uri.parse("oilataxidriver://accept?orderId=$orderId")
            )
            intent.setPackage(packageName)
            intent.addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or
                Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
            )
            startActivity(intent)
        } catch (e: Exception) {
            // Agar biror sabab bilan deep link ishlamasa, hech
            // bo'lmasa ilovani oddiy usulda ochamiz
            launchApp()
        }
    }

    private fun launchApp() {
        try {
            val intent = packageManager.getLaunchIntentForPackage(packageName)
            intent?.addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or
                Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
            )
            if (intent != null) startActivity(intent)
        } catch (_: Exception) {}
    }

    // MUHIM: avval bu yerda RingtoneManager orqali TELEFONNING
    // STANDART ringtoni olinar edi — shuning uchun har xil telefonda
    // har xil (default) ovoz eshitilar edi. Endi ilova o'ziga
    // BIRIKTIRILGAN maxsus ovozni (res/raw/asosiy_ovoz — bu fayl
    // build vaqtida assets/sounds/asosiy_ovoz.mp3'dan avtomatik
    // ko'chiriladi, withNotificationSound.js plagini orqali)
    // ishlatadi — barcha telefonlarda BIR XIL ovoz chalinadi.
    private fun playRingtone() {
        try {
            val resId = resources.getIdentifier("asosiy_ovoz", "raw", packageName)
            mediaPlayer = if (resId != 0) {
                MediaPlayer.create(this, resId)
            } else {
                null
            }
            mediaPlayer?.apply {
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build()
                )
                isLooping = true
                start()
            }
        } catch (_: Exception) {}
    }

    private fun stopRingtone() {
        try { mediaPlayer?.stop(); mediaPlayer?.release() } catch (_: Exception) {}
        mediaPlayer = null
    }

    private fun formatPrice(value: Long): String =
        value.toString().reversed().chunked(3).joinToString(" ").reversed()

    private fun sendEventToJS(eventName: String, orderId: String) {
        try {
            val reactApp = application as? ReactApplication ?: return
            val reactContext = reactApp.reactHost?.currentReactContext ?: return
            val params: WritableMap = Arguments.createMap()
            params.putString("orderId", orderId)
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(eventName, params)
        } catch (_: Exception) {}
    }

    override fun onDestroy() {
        super.onDestroy()
        removeOverlay()
    }
}