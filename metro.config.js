const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

// "functions" papkasini bundledan chiqarib tashlaymiz —
// bu server kodi, React Native ilovasiga tegishli emas.
config.watchFolders = (config.watchFolders || []).filter(
  (folder) => !folder.includes('functions')
);

config.resolver.blockList = [
  /functions\/.*/,
];

module.exports = config;