/**
 * withNotificationSound.js
 *
 * Bu — Expo Config Plugin. `expo prebuild` (yoki EAS Build) ishga
 * tushganda, assets/sounds/asosiy_ovoz.mp3 faylini Android native
 * loyihasiga (android/app/src/main/res/raw/asosiy_ovoz.mp3) nusxalaydi.
 *
 * NEGA KERAK: Android'da xabarnoma/overlay ovozi faqat native
 * res/raw/ resursidan chalinishi mumkin — JS/assets papkasidagi
 * fayldan TO'G'RIDAN-TO'G'RI chalib bo'lmaydi (bu faqat expo-av
 * orqali, ilova FOREGROUND holatida ishlaydi). Shuning uchun
 * OrderOverlayService.kt (native overlay ringtoni) va Notifee
 * notification channel (fallback) ikkalasi ham shu res/raw resursini
 * ishlatadi.
 *
 * MUHIM: withOverlayPermission.js kabi, bu plugin ham HAR SAFAR
 * prebuild ishga tushganda qayta ishlaydi — android/ papkasi qayta
 * yaratilsa ham fayl yo'qolib qolmaydi.
 */

const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

module.exports = function withNotificationSound(config) {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const projectRoot = config.modRequest.projectRoot;

      const rawDir = path.join(
        projectRoot,
        'android',
        'app',
        'src',
        'main',
        'res',
        'raw'
      );
      if (!fs.existsSync(rawDir)) {
        fs.mkdirSync(rawDir, { recursive: true });
      }

      const soundSource = path.join(projectRoot, 'assets', 'sounds', 'asosiy_ovoz.mp3');
      const soundTarget = path.join(rawDir, 'asosiy_ovoz.mp3');

      if (fs.existsSync(soundSource)) {
        fs.copyFileSync(soundSource, soundTarget);
      } else {
        console.warn(
          'withNotificationSound: assets/sounds/asosiy_ovoz.mp3 topilmadi — xabarnoma ovozi build\'ga qo\u2018shilmadi.'
        );
      }

      return config;
    },
  ]);
};