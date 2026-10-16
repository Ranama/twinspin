# TwinSpin contract addendum: song sources (Google Drive + music server / Synology NAS) (v5)

Extends `docs/CONTRACT.md`, `docs/AUTOMIX.md`, `docs/PLAYER.md` and `docs/CHANGES.md` (all binding). Research:
`docs/research/sources/research-{gdrive,synology,catalogs}.md` and the `verify-*` files (verify corrections win).

## 0. What the user asked for

> "Regarding the player, can you make it possible to load from Google Drive? Also make it possible to connect songs
> from a Synology NAS drive."

Facts that shape the design (from the research):
* Google Drive works from a static site with no backend: Google Identity Services (GIS) token model with the
  non-sensitive `drive.file` scope + the Google Picker + `GET https://www.googleapis.com/drive/v3/files/{id}?alt=media`
  with `Authorization: Bearer` (CORS confirmed for https://ranama.github.io and http://localhost:8100). The user must
  create a Google Cloud project and give us three PUBLIC values: OAuth Web client ID, API key, project NUMBER.
* Synology DSM's own API cannot be called from another origin (no CORS, no setting). The robust in-app route is a
  **Subsonic/OpenSubsonic music server on the NAS: Navidrome** (sends `Access-Control-Allow-Origin: *`), reached over
  HTTPS via the NAS's DDNS name (`*.synology.me`) with a Let's Encrypt certificate and a DSM reverse proxy. The same
  connector works with any Subsonic-compatible server (Navidrome, Gonic, Airsonic-Advanced, Ampache).
* Zero-code fallback for both: the phone's own file picker already reaches Google Drive (iOS Files / Android picker)
  and the NAS (iOS Files "Connect to Server" SMB, the Synology Drive app, Android CIFS Documents Provider). Our
  existing "Add music" file input therefore already works with them; we explain it in the UI.

## 1. Config (`config.js`, lead-owned; read through `config` in `src/core/env.js`)

```js
window.TWINSPIN_CONFIG = { google: { clientId: '', apiKey: '', appId: '' } };   // empty = Drive button explains setup
```
`index.html`: change `<meta name="referrer" content="no-referrer">` to `strict-origin` (Google API keys restricted
by website need the origin as referrer; only the origin is sent, never the path).

## 2. Library: remote songs (`src/library/library.js`)

* New entry fields: `source: 'file' | 'demo' | 'gdrive' | 'subsonic'`, `remote: { kind, ... } | null`
  (gdrive: `{ kind: 'gdrive', fileId }`; subsonic: `{ kind: 'subsonic', serverId, songId }`), `stored: boolean`.
* `addRemote(entries)`: add songs WITHOUT a stored file (music-server songs). Dedupe by `remote.kind + id`. Stored-file
  cap (60) does not apply; remote entries are capped at 1000 (oldest unused go first).
* `getBlob(id)`: stored -> as today; remote and not stored -> `resolveRemote(entry)` through a registered resolver
  (`library.setResolver(kind, async (entry, { signal, onProgress }) => Blob)`), with a small in-memory LRU cache
  (max 3 blobs) for the session.
* `saveOffline(id)`: download a remote song and store it (then `stored: true`).
* Google Drive picks are downloaded at pick time and stored like normal files (`library.add(files, { source:
  'gdrive', remote })` keeps `driveFileId` for a later re-download); Drive tokens expire after 1 h and need a user tap,
  so on-demand Drive playback is not attempted.
* Everything else (Playlist, Player, Deck loading via library blobs) keeps working unchanged; `Deck` must not care
  where a blob came from. Loading a remote song shows a download progress state on the deck/player.

## 3. Source modules (`src/sources/`, new, UI-agnostic, testable with stubbed `fetch`/globals)

### 3.1 `gdrive.js`
```js
export class GoogleDriveSource extends Emitter {
  constructor({ config, library })
  readonly configured: boolean                 // all three config values present
  readonly ready: boolean                      // api.js + gsi loaded
  preload(): Promise<void>                     // load https://apis.google.com/js/api.js (gapi.load('picker')) and
                                               // https://accounts.google.com/gsi/client; call when the Songs/Add sheet opens
  pick(): Promise<File[]>                      // MUST be called synchronously from a tap: requestAccessToken (prompt ''
                                               // when already granted, 'consent' first time) -> Picker (DocsView LIST,
                                               // audio MIME types incl. audio/mpeg, audio/mp4, audio/x-m4a, audio/wav,
                                               // audio/x-wav, audio/flac, audio/ogg, audio/aac; folders visible;
                                               // MULTISELECT; setMaxItems(100); setOAuthToken; setDeveloperKey; setAppId;
                                               // setOrigin(location.origin)) -> download each picked file (2 in parallel,
                                               // progress events) -> File objects (name, type, lastModified)
  importLink(url): Promise<File[]>             // public "anyone with the link" file or folder URL: API key only
                                               // (files.get / files.list q="'<id>' in parents and mimeType contains 'audio/'"
                                               // fields, then alt=media&key=), no sign-in
  signOut()
  // events: 'progress'({ done, total, bytes, totalBytes, name }), 'error'(message), 'state'
}
export function parseDriveUrl(url): { kind: 'file'|'folder', id } | null   // pure, tested
```
Errors in plain words (not configured, popup blocked: "Allow pop-ups for TwinSpin, or use Add music > Google Drive
in your phone's file picker", 401 -> reconnect, 403 not shared / quota, 404). Inject a mobile CSS override for the
Picker dialog (`.picker-dialog` full-width under 600 px). Never use the implicit redirect flow (discouraged by Google
and it would unload the audio engine).

### 3.2 `subsonic.js` + `md5.js`
```js
export function md5(str): string                          // pure, tested against RFC 1321 vectors
export class SubsonicClient {                              // pure-ish: fetch injected
  constructor({ url, username, token, salt, apiKey, fetch, clientName = 'TwinSpin' })
  ping(), getArtists(), getArtist(id), getAlbumList2(type, size, offset), getAlbum(id), search3(query),
  getPlaylists(), getPlaylist(id), getRandomSongs(size), coverArtUrl(id, size), downloadUrl(songId)
  download(songId, { signal, onProgress }): Promise<Blob>   // download.view (original file); fall back to
                                                             // stream.view?format=raw
}
export function authParams({ username, password | token+salt | apiKey }) // u, t=md5(password+salt), s, v=1.16.1,
                                                             // c=TwinSpin, f=json; OpenSubsonic apiKey when given
export class MusicServerSource extends Emitter {           // connection management for the UI
  constructor({ settings, library })
  connect({ url, username, password, remember }): Promise<void>   // normalises URL (https required except
                    // localhost / private IPs, which are allowed with a warning that only Chrome supports them),
                    // pings, stores { url, username, token, salt } (never the password) in localStorage when
                    // remember, else sessionStorage; registers the library resolver 'subsonic'
  disconnect(), readonly connected, readonly server ({ id, url, name, type, version })
  readonly client: SubsonicClient | null
  toEntries(songs): LibraryRemoteEntry[]                   // title, artist, album, duration, bpm (if the server has
                                                           // it), coverArt, remote { kind:'subsonic', serverId, songId }
  // events: 'state', 'error'(message)
}
```
Errors in plain words: wrong password, server not reachable ("Check the address. From outside your home use the
https://….synology.me address."), certificate problems, CORS (server is not Navidrome/Subsonic or the reverse proxy
strips headers), mixed content (http address from the https app).

## 4. UI (`src/ui/**`, `css/*`, `index.html`)

* **Add music sheet** (replaces the single "+ Add music" button on the Songs page and the Player's empty state; also
  reachable from the Player page): big options **This device** (existing file input, unchanged), **Google Drive**,
  **Music server / NAS**, **Paste a Drive link**; and a collapsible "Other ways" hint card: iPhone Files app (Google
  Drive, Synology Drive, Connect to Server/SMB), Android system picker (Drive) and CIFS Documents Provider, computer
  network drive. Drive button when not configured: a short explanation and a link to the setup guide
  (`docs/GOOGLE_DRIVE.md` on GitHub). Import progress (n of m, MB) with cancel.
* **Music server browser** (sheet/page in all layouts, phone-first): connect form (address, user, password, "Remember
  on this device"), then tabs Artists / Albums / Playlists / Search, album and playlist views with cover art, song rows
  with Play now / Play next / Add to queue / Load A / Load B (reuse the Songs row action sheet), "Add all" for an album
  or playlist, "Save offline" per song, disconnect. Lists virtualised or paginated (large libraries).
* Remote songs in the library/set list show a small cloud/server badge; loading shows progress; offline errors are
  clear ("Can't reach your music server").
* Settings: Music server section (connected server, disconnect), Google Drive section (sign out).
* Help: short "Your music from Google Drive or your NAS" section.
* `docs/GOOGLE_DRIVE.md` and `docs/SYNOLOGY.md`: step-by-step user guides (from the research: Cloud Console steps
  with the exact origins https://ranama.github.io and http://localhost:8100, API key restrictions incl. referrers and
  APIs, consent screen External + Publish app, drive.file in Data Access, homepage/privacy links (add
  `privacy.html`, a short plain privacy page: nothing leaves the device except requests to the services the user
  connects), no logo; Navidrome in Container Manager compose, DDNS + Let's Encrypt, reverse proxy, a read-only user;
  the zero-code SMB / Synology Drive / CIFS routes). README: features + links.
* Browser QA fixture (dev only, not shipped by publish-web): `tests/fixtures/subsonic/rest/*.view` static JSON files
  (ping, getArtists, getArtist, getAlbumList2, getAlbum, search3, getPlaylists, getPlaylist) plus a small audio file,
  so the music-server browser can be exercised against `http://localhost:8100/tests/fixtures/subsonic` (the static
  server ignores the query string).

## 5. Ownership

| Agent | Files |
|---|---|
| lead | `src/core/*`, `config.js`, `docs/SOURCES.md` |
| core | `src/sources/*`, `src/library/library.js`, `tests/{gdrive,subsonic,md5,library-remote,library}.test.js` |
| ui | `index.html`, `privacy.html`, `css/*`, `src/main.js`, `src/ui/**`, `sw.js` (SHELL), `tools/publish-web.ps1` (only to include privacy.html and exclude tests/fixtures), `docs/GOOGLE_DRIVE.md`, `docs/SYNOLOGY.md`, `README.md`, `tests/ui-*.test.js`, `tests/fixtures/**` |
