/**
 * withOverlayPermission.js
 *
 * Bu — Expo Config Plugin. Vazifasi: `expo prebuild` (yoki EAS Build)
 * ishga tushganda, Android native loyihasiga avtomatik ravishda:
 *
 *  1. OverlayModule.kt, OverlayPackage.kt, OrderOverlayService.kt
 *     fayllarini ko'chiradi (android/app/src/main/java/.../ ichiga)
 *  2. layout_order_overlay.xml va overlay_*.xml drawable fayllarni
 *     android/app/src/main/res/ ichiga ko'chiradi
 *  3. MainApplication.kt ichida OverlayPackage()ni ro'yxatdan
 *     o'tkazadi
 *  4. MainActivity.kt ga setShowWhenLocked(true) va
 *     setTurnScreenOn(true) chaqiruvlarini qo'shadi
 *  5. AndroidManifest.xml ga OrderOverlayService'ni <service> sifatida
 *     ro'yxatdan o'tkazadi
 *
 * MUHIM: bu plugin har safar `expo prebuild` ishga tushganda
 * (shu jumladan EAS Build serverida) ishlaydi, shuning uchun
 * android/ papkasi har safar qaytadan yaratilsa ham, bizning
 * o'zgarishlarimiz YO'QOLMAYDI.
 */

const {
  withDangerousMod,
  withMainActivity,
  withMainApplication,
  withAndroidManifest,
} = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

function withOverlayNativeFiles(config) {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const projectRoot = config.modRequest.projectRoot;
      // MUHIM: paket nomi endi app.json'dagi android.package'dan
      // DINAMIK olinadi — avval "com/aslzodiy3/AloTaxiDriver" qattiq
      // yozilgan edi, shuning uchun bu plagin boshqa package nomi
      // bilan (masalan Zuvzuv, Vijdon) ishlatilganda Kotlin fayllari
      // noto'g'ri papkaga tushib, "Unresolved reference" xatosi
      // bilan build butunlay buzilar edi.
      const androidPackage = config.android && config.android.package;
      if (!androidPackage) {
        throw new Error(
          'withOverlayPermission: app.json ichida android.package topilmadi.'
        );
      }
      // MUHIM: "Qabul qilish" tugmasi bosilganda ishlatiladigan chuqur
      // havola (deep link) sxemasi ham avval "oilataxidriver" deb
      // qattiq yozilgan edi — bu esa boshqa scheme (masalan
      // "zuvzuvtaxidriver") bilan ishlaydigan ilovalarda "Qabul
      // qilish" tugmasini ishlamay qoladigan qilib qo'yar edi (ilova
      // ochiladi, lekin buyurtma ma'lumoti yetib bormaydi). Endi
      // app.json'dagi "scheme" qiymatidan avtomatik olinadi.
      const appScheme = config.scheme;
      if (!appScheme) {
        throw new Error(
          'withOverlayPermission: app.json ichida "scheme" topilmadi.'
        );
      }
      const packagePath = androidPackage.replace(/\./g, '/');
      const javaTargetDir = path.join(
        projectRoot,
        'android',
        'app',
        'src',
        'main',
        'java',
        packagePath
      );

      if (!fs.existsSync(javaTargetDir)) {
        fs.mkdirSync(javaTargetDir, { recursive: true });
      }

      const kotlinSourceDir = path.join(projectRoot, 'plugins', 'overlay-native');

      // Oddiy nusxalash o'rniga: har bir faylni o'qib, undagi
      // "package com.aslzodiy3.AloTaxiDriver" qatorini va
      // "oilataxidriver://" chuqur havola sxemasini haqiqiy
      // qiymatlarga almashtirib, keyin yozamiz.
      ['OverlayModule.kt', 'OverlayPackage.kt', 'OrderOverlayService.kt'].forEach(
        (fileName) => {
          let content = fs.readFileSync(
            path.join(kotlinSourceDir, fileName),
            'utf8'
          );
          content = content.replace(
            /^package\s+[a-zA-Z0-9_.]+/m,
            `package ${androidPackage}`
          );
          content = content.split('oilataxidriver://').join(`${appScheme}://`);
          fs.writeFileSync(path.join(javaTargetDir, fileName), content);
        }
      );

      // Layout fayl
      const layoutTargetDir = path.join(
        projectRoot,
        'android',
        'app',
        'src',
        'main',
        'res',
        'layout'
      );
      if (!fs.existsSync(layoutTargetDir)) {
        fs.mkdirSync(layoutTargetDir, { recursive: true });
      }

      const resSourceDir = path.join(kotlinSourceDir, 'res-layout');

      fs.copyFileSync(
        path.join(resSourceDir, 'layout_order_overlay.xml'),
        path.join(layoutTargetDir, 'layout_order_overlay.xml')
      );

      // Drawable fayllar
      const drawableTargetDir = path.join(
        projectRoot,
        'android',
        'app',
        'src',
        'main',
        'res',
        'drawable'
      );
      if (!fs.existsSync(drawableTargetDir)) {
        fs.mkdirSync(drawableTargetDir, { recursive: true });
      }

      [
        'overlay_card_background.xml',
        'overlay_pill_background.xml',
        'overlay_btn_accept_background.xml',
        'overlay_btn_decline_background.xml',
        'overlay_dot_primary.xml',
      ].forEach((fileName) => {
        fs.copyFileSync(
          path.join(resSourceDir, fileName),
          path.join(drawableTargetDir, fileName)
        );
      });

      return config;
    },
  ]);
}

function withOverlayPackageRegistration(config) {
  return withMainApplication(config, (config) => {
    let contents = config.modResults.contents;

    if (!contents.includes('OverlayPackage()')) {
      contents = contents.replace(
        /(PackageList\(this\)\.packages\.apply\s*\{)/,
        `$1\n              add(OverlayPackage())`
      );
    }

    config.modResults.contents = contents;
    return config;
  });
}

function withOverlayActivityFlags(config) {
  return withMainActivity(config, (config) => {
    let contents = config.modResults.contents;

    const flagsCode = `
    // Full-screen push notification (incoming-order) ekrani uchun:
    // bu chaqiruvlar Activity'ni ekran qulflangan bo'lsa ham
    // ko'rsatishga va ekranni avtomatik yoqishga ruxsat beradi.
    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O_MR1) {
      setShowWhenLocked(true)
      setTurnScreenOn(true)
    }`;

    if (!contents.includes('setShowWhenLocked')) {
      contents = contents.replace(
        /(super\.onCreate\([^)]*\)\s*)/,
        `$1${flagsCode}\n`
      );
    }

    config.modResults.contents = contents;
    return config;
  });
}

function withOrderOverlayServiceManifest(config) {
  return withAndroidManifest(config, (config) => {
    const application = config.modResults.manifest.application[0];

    if (!application.service) {
      application.service = [];
    }

    const alreadyAdded = application.service.some(
      (s) => s['$']['android:name'] === '.OrderOverlayService'
    );

    if (!alreadyAdded) {
      application.service.push({
        $: {
          'android:name': '.OrderOverlayService',
          'android:exported': 'false',
        },
      });
    }

    return config;
  });
}

module.exports = function withOverlayPermission(config) {
  config = withOverlayNativeFiles(config);
  config = withOverlayPackageRegistration(config);
  config = withOverlayActivityFlags(config);
  config = withOrderOverlayServiceManifest(config);
  return config;
};