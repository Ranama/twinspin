// TwinSpin deployment config (classic script, loaded before the app modules).
// The claude.ai artifact preview build overwrites this with { preview: true } (no service worker, no WebRTC).
// Optional keys: peerJsUrl, peerOptions ({ host, port, path, key, secure } of your own PeerJS server),
// iceServers (RTCIceServer[]).
window.TWINSPIN_CONFIG = window.TWINSPIN_CONFIG || {};
