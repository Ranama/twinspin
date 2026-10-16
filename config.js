// TwinSpin deployment config (classic script, loaded before the app modules).
// The claude.ai artifact preview build overwrites this with { preview: true } (no service worker, no WebRTC).
// Optional keys: peerJsUrl, peerOptions ({ host, port, path, key, secure } of your own PeerJS server),
// iceServers (RTCIceServer[]).
// google: the three PUBLIC values from your Google Cloud project (docs/GOOGLE_DRIVE.md). Empty = the Google Drive
// button explains how to set it up. They are not secrets: the API key is restricted to this website and the
// client ID only works from the registered origins.
window.TWINSPIN_CONFIG = window.TWINSPIN_CONFIG || {
  google: { clientId: '', apiKey: '', appId: '' },
};
