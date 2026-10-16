// TwinSpin deployment config (classic script, loaded before the app modules).
// The claude.ai artifact preview build overwrites this with { preview: true } (no service worker, no WebRTC).
// Optional keys: peerJsUrl, peerOptions ({ host, port, path, key, secure } of your own PeerJS server),
// iceServers (RTCIceServer[]).
// google: the three PUBLIC values from the Google Cloud project (docs/GOOGLE_DRIVE.md). They are not secrets: the
// API key is restricted to https://ranama.github.io, http://localhost:8100 and docs.google.com and to the Picker and
// Drive APIs, and the OAuth client ID only works from the registered origins.
window.TWINSPIN_CONFIG = window.TWINSPIN_CONFIG || {
  google: {
    clientId: '698229146374-t2su2dk962vdttb4fmavlln5a3shnijq.apps.googleusercontent.com',
    apiKey: 'AIzaSyCtOAhjRgrJNixx9MHwh8PfWTP2HSKkR5E',
    appId: '698229146374',
  },
};
