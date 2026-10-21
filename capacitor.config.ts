import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.auxbattles.game',
  appName: 'AUX Battles',
  webDir: process.env.AUX_NATIVE_BUILD === '1' ? 'apps/web/dist-mobile' : 'apps/web/dist',
  backgroundColor: '#f7f5f0',
  loggingBehavior: 'none',
  server: {
    hostname: 'localhost',
    iosScheme: 'capacitor',
    androidScheme: 'https',
  },
};

export default config;
