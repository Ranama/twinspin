# Subsonic test server (browser QA fixture)

A fake Navidrome / Subsonic server made of static files, so the TwinSpin music-server browser can be tried
without a NAS. Development only: `tools/publish-web.ps1` never ships `tests/`.

1. Start the local server: `powershell -ExecutionPolicy Bypass -File tools\serve.ps1` (http://localhost:8100).
2. Open http://localhost:8100/?nosw, tap Start, then Songs > Add music > Music server / NAS.
3. Address `http://localhost:8100/tests/fixtures/subsonic`, any user name and password, Connect.

`rest/<method>.view` is the JSON answer of that Subsonic method. The static server ignores the query string, so
every `getArtist` answer is the same artist, every `getAlbum` the album "Night Drive", every `getPlaylist` the
playlist "Warm-up", and every song downloads the same 8 second, 124 BPM WAV (`download.view`, also
`stream.view`). `getCoverArt.view` is a 120 x 120 PNG.

| File | Answer |
|---|---|
| `ping.view` | ok (type navidrome, OpenSubsonic) |
| `getArtists.view` | 3 artists in 3 index letters |
| `getArtist.view` | Aurora Lane with 2 albums |
| `getAlbumList2.view` | 4 albums |
| `getAlbum.view` | Night Drive, 4 songs |
| `search3.view` | 1 artist, 2 albums, 3 songs (for any query) |
| `getPlaylists.view` / `getPlaylist.view` | 2 playlists / Warm-up with 4 songs |
| `getRandomSongs.view` | 5 songs |
| `getLicense.view`, `getMusicFolders.view`, `getOpenSubsonicExtensions.view` | small answers some clients ask for |
| `download.view`, `stream.view` | the song (WAV, 16 kHz mono, 8 s) |
| `getCoverArt.view` | the cover (PNG) |

Any short WAV and PNG can replace `download.view` / `stream.view` and `getCoverArt.view` (these were made once
with a few lines of PowerShell: a 124 BPM kick, off-beat hats and a bass note per bar; a gradient record).
