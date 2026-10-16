// Puts extras/suno-playlist-downloader.js into test mode. Import this BEFORE the script: static imports run in
// order, so the script then sees globalThis.__SUNO_PLAYLIST_TEST__ === true, touches no page (no DOM, no Clerk, no
// fetch) and only exposes its helpers and run engine on globalThis.__SUNO_PLAYLIST__.
//   import './helpers/suno-test-flag.js';
//   import '../extras/suno-playlist-downloader.js';
globalThis.__SUNO_PLAYLIST_TEST__ = true;
