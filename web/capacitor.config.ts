import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'dev.lanesignal.app',
  appName: 'LaneSignal',
  webDir: 'dist',
  android: {
    // Plain-HTTP servers are blocked by default; put LaneSignal behind HTTPS
    // (reverse proxy, Tailscale serve, ...). Set LANESIGNAL_ALLOW_HTTP=1 at
    // `cap sync` time for LAN testing only.
    allowMixedContent: process.env.LANESIGNAL_ALLOW_HTTP === '1',
  },
  server: {
    androidScheme: 'https',
    cleartext: process.env.LANESIGNAL_ALLOW_HTTP === '1',
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
};

export default config;
