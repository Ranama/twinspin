# research-gdrive
## Verdict
This can be built with no backend. The approach: (1) the Google Identity Services token model (popup) gets a 1-hour access token for the non-sensitive scope drive.file; (2) the Google Picker (apis.google.com/js/api.js, gapi.load('picker')) lets the user choose audio files, and Picker selection is what gives the app per-file access; (3) the app fetches each file with GET https://www.googleapis.com/drive/v3/files/{id}?alt=media and an Authorization: Bearer header, then hands it to the existing library.add() as a File.

CORS was checked live on 2026-10-15/16. The preflight from both https://ranama.github.io and http://localhost:8100 returns 200 with Access-Control-Allow-Origin echoed and Access-Control-Allow-Headers: authorization,range,x-goog-drive-resource-keys.

With only drive.file, the consent screen can be published "In production" without verification. There is no unverified-app warning, no 100-user cap and no 7-day expiry. One cosmetic catch: without brand verification, the consent screen shows the domain instead of the name "TwinSpin". Brand verification on a github.io subdomain is unreliable.

Main risks:
- Mobile: Google documents no mobile-browser support matrix for the web Picker. Its dialog sizing is desktop-oriented (setSize minimum 566x350), so it needs a real test on iPhone and Android and probably a CSS override.
- TwinSpin's manifest uses display:standalone. When installed to the home screen on iOS, the GIS popup may fail to return a token. A redirect-based token fallback is advisable.

Two zero-OAuth complements are worth shipping alongside:
- The OS file picker: the iOS Files app and the Android system picker both already offer Google Drive as a source.
- Paste a public share link or folder link: Drive API plus API key, with CORS confirmed.
## Recommendation
Build approach A (GIS token model + Google Picker + drive.file + fetch alt=media into Library.add) as the main 'Google Drive' button. Ship two zero-risk complements with it: approach D, an in-app hint that the existing 'Add songs' picker already reaches Google Drive through the iOS Files app and the Android system picker, and optionally approach B, 'paste a public Drive file/folder link', which uses the same API key and also allows whole-folder import.

Before shipping, implement approach C (a redirect-token fallback) for iOS home-screen mode, because TwinSpin is display:standalone.

Ask the user to do the 10 Cloud Console steps once and send back three values: Client ID, API key, and Project NUMBER.
- Use only the drive.file scope.
- Set the consent screen to External and 'Publish app' (In production). No verification is needed for drive.file.
- Register JS origins https://ranama.github.io and http://localhost:8100, plus redirect URIs https://ranama.github.io/twinspin/ and http://localhost:8100/ for the fallback.
- Restrict the API key to the websites https://ranama.github.io/*, http://localhost:8100/* and https://docs.google.com/*, and to the APIs Google Picker API and Google Drive API.

In code:
- Preload api.js and gsi/client so requestAccessToken({prompt: ''}) runs synchronously in the tap handler.
- Keep the token in memory or sessionStorage with an expiry, and show a 'Reconnect' button after about 55 minutes.
- Use DocsView in LIST mode with explicit audio MIME types, folders shown, MULTISELECT and setMaxItems(100).
- Stream downloads with a progress bar, 2-3 in parallel, and handle 401, 403 and 404 reasons.
- Store driveFileId on each library entry for re-download.
- Add a ≤600px CSS override for the Picker dialog.

Then test on a real iPhone (Safari tab and home-screen app) and an Android phone before calling it done. The Picker's mobile layout is the largest unknown.
### A. Google Picker + GIS token model + drive.file + fetch alt=media (recommended main path)
- **howItWorks**: 1) On load, or when the Drive panel opens, lazy-load https://apis.google.com/js/api.js and https://accounts.google.com/gsi/client, then call gapi.load('picker', cb). 2) The user taps 'Google Drive'. The tap handler synchronously calls tokenClient.requestAccessToken({prompt: ''}), and a Google popup returns an access token for https://www.googleapis.com/auth/drive.file (expires_in about 3599 s; no refresh token). 3) Build a PickerBuilder with setOAuthToken(token), setDeveloperKey(apiKey), setAppId(projectNumber), MULTISELECT_ENABLED and a DocsView filtered to audio MIME types with folders shown for navigation. 4) Each file the user selects becomes accessible to the app under drive.file. In the callback, fetch https://www.googleapis.com/drive/v3/files/{id}?alt=media with an Authorization: Bearer header, stream it with progress, wrap it in a File, and pass it to Library.add([file]) (D:\Claude\TwinSpin\src\library\library.js:219). 5) Keep the Drive fileId on the library entry. The per-file grant persists, so later tokens can re-download the file.
- **userSetup**: In Google Cloud Console (console.cloud.google.com), signed in with the Google account that will own the app:
1. Top-bar project selector > New project > Name 'TwinSpin' > Create, then select it. No billing account is needed.
2. APIs & Services > Library > search 'Google Drive API' > Enable. Back to Library > search 'Google Picker API' > Enable.
3. Menu > Google Auth Platform > Branding. If it says 'Google Auth platform not configured yet', click Get Started. App name 'TwinSpin', User support email = your Gmail > Next. Audience: External > Next. Contact information: your email > Next. Tick 'I agree to the Google API Services: User Data Policy' > Continue > Create.
4. Branding page (optional but recommended): App home page https://ranama.github.io/twinspin/. Authorized domains: add ranama.github.io. github.io is on the Public Suffix List, so the registrable domain is ranama.github.io. Save. A privacy policy and logo are only needed if you ever want brand verification.
5. Google Auth Platform > Data Access > Add or Remove Scopes > filter 'drive.file' > tick '.../auth/drive.file' > Update > Save.
6. Google Auth Platform > Audience. While testing: Test users > Add users > your Gmail > Save. To ship to everyone, click 'Publish app' > Confirm, so the status becomes 'In production'. With only drive.file, no verification is required. While in Testing: max 100 test users, test users see an unverified warning, and consent expires after 7 days.
7. Google Auth Platform > Clients > Create Client > Application type 'Web application' > Name 'TwinSpin web'. Under Authorized JavaScript origins, Add URI 'https://ranama.github.io' and Add URI 'http://localhost:8100'. Use origins only: no path, no trailing slash, port must match. Optionally add 'http://127.0.0.1:8100' too. Optionally, for the iOS-PWA redirect fallback in approach C, add Authorized redirect URIs 'https://ranama.github.io/twinspin/' and 'http://localhost:8100/'. Leave 'Use this client for an AI-powered agent' unchecked; it cannot be changed later. Create, then copy the Client ID (…apps.googleusercontent.com). The client secret is not used; ignore it. Origin changes can take 5 minutes to a few hours to apply.
8. APIs & Services > Credentials > Create credentials > API key. The console requires at least one API restriction: choose Google Picker API, plus Google Drive API if you also want approach B. Then open the key > Application restrictions > Websites > Add: 'https://ranama.github.io/*', 'http://localhost:8100/*', 'https://docs.google.com/*'. The docs.google.com entry is mandatory because the Picker iframe runs there; without it you get 'API developer key is invalid'. Save and copy the key (AIza…).
9. Menu > IAM & Admin > Settings (or the dashboard Project info card): copy the 12-digit Project NUMBER, not the project ID. This is the Picker appId and must come from the same project as the client ID.
10. Give the three values to TwinSpin config: window.TWINSPIN_CONFIG.google = {clientId, apiKey, appId}. All three are public by design.
Maintenance: OAuth clients unused for 6 months are deleted automatically (restorable for 30 days). Keep the project contact email current.
- **browserConstraints**: CORS, tested live:
- Preflight OPTIONS to https://www.googleapis.com/drive/v3/files/{id}?alt=media with Origin https://ranama.github.io returns 200, Access-Control-Allow-Origin: https://ranama.github.io, Allow-Methods including GET, and Allow-Headers authorization,range,x-goog-drive-resource-keys. The same holds for http://localhost:8100.
- GET responses (401 and 400 observed) carry ACAO and Access-Control-Expose-Headers that include Content-Length but not Content-Range, so read total size from Content-Length or the Picker's sizeBytes.
- Mixed content: none. All endpoints are https, and localhost counts as a secure context.
- TwinSpin's sw.js ignores cross-origin requests, so googleapis traffic bypasses the service worker. Good.

Popups:
- The GIS token model is popup-only ('only the dialog UX is supported').
- requestAccessToken must run synchronously inside the tap/click handler. Any await before it causes iOS Safari to block the popup, so preload both scripts and init the token client before the tap.
- The Picker itself is an in-page iframe overlay, not a popup, so it needs no gesture.

iPhone Safari (normal tab): the GIS popup opens as a new tab and returns to the page; expected to work. Picker: Google states that web apps use the JS library, but publishes no mobile-browser guarantee. Dialog sizing is desktop-oriented (setSize min 566x350, max 1051x650), so expect a cramped or overflowing dialog on a 375-430 px viewport. Test on a real device, and consider a CSS override on the parent-page dialog elements (undocumented class names, see apiDetails).

iPhone home-screen PWA (TwinSpin manifest has display:standalone): popup/opener OAuth flows are known to break in iOS standalone mode (Firebase/Auth0 reports). Detect navigator.standalone or matchMedia('(display-mode: standalone)') and use the redirect fallback (approach C).

Android Chrome: GIS popup works, including installed PWAs per reports. Picker renders in the page; same sizing caveat.

Third-party cookies: the Picker gets auth via setOAuthToken, not cookies. A Nov 2025 developer report says the Picker fails inside in-app browsers or WebViews (Instagram, Facebook and similar in-app browsers), and Google says it cannot run in embedded webviews. Show an 'open in Safari/Chrome' hint when an in-app browser is detected.

Memory: whole-file Blob plus decodeAudioData. Large WAV/FLAC files (100+ MB) can hit iOS memory limits, so cap or warn on size.
- **apiDetails**: Scripts: <script src="https://apis.google.com/js/api.js"> then gapi.load('picker', cb). <script src="https://accounts.google.com/gsi/client">. gapi.client is not needed; use plain fetch.

Token client:
const SCOPE='https://www.googleapis.com/auth/drive.file';
tokenClient = google.accounts.oauth2.initTokenClient({ client_id: cfg.clientId, scope: SCOPE, callback: r => { if (r.error || !google.accounts.oauth2.hasGrantedAllScopes(r, SCOPE)) return fail(r); token = r.access_token; tokenExp = Date.now() + (r.expires_in - 60)*1000; openPicker(); }, error_callback: e => fail(e) /* e.type: popup_failed_to_open | popup_closed | unknown */ });
btn.onclick = () => (token && Date.now() < tokenExp) ? openPicker() : tokenClient.requestAccessToken({ prompt: '' });
Prompt semantics: the default is 'select_account' (account chooser every time). '' shows prompts only the first time. 'consent' forces the consent screen. 'none' shows nothing and fails if interaction is needed. Optional login_hint: email, to skip the chooser. include_granted_scopes defaults to true. TokenResponse fields: access_token, expires_in (about 3599), scope, token_type. There is no refresh token: after expiry, show a 'Reconnect Google Drive' button, because renewal needs a user gesture. Sign-out: google.accounts.oauth2.revoke(token).

Picker:
const AUDIO='audio/mpeg,audio/mp3,audio/mp4,audio/x-m4a,audio/m4a,audio/aac,audio/wav,audio/x-wav,audio/vnd.wave,audio/wave,audio/flac,audio/x-flac,audio/ogg,audio/opus,audio/webm,audio/aiff,audio/x-aiff'; // use explicit types; wildcard 'audio/*' is undocumented
const P=google.picker;
const browse=new P.DocsView(P.ViewId.DOCS).setMimeTypes(AUDIO).setIncludeFolders(true).setSelectFolderEnabled(false).setParent('root').setMode(P.DocsViewMode.LIST);
const search=new P.DocsView(P.ViewId.DOCS).setMimeTypes(AUDIO).setMode(P.DocsViewMode.LIST);
const shared=new P.DocsView(P.ViewId.DOCS).setMimeTypes(AUDIO).setOwnedByMe(false).setMode(P.DocsViewMode.LIST);
new P.PickerBuilder().setAppId(cfg.appId).setDeveloperKey(cfg.apiKey).setOAuthToken(token).enableFeature(P.Feature.MULTISELECT_ENABLED).enableFeature(P.Feature.SUPPORT_DRIVES).setMaxItems(100).addView(browse).addView(search).addView(shared).setTitle('Add songs from Google Drive').setLocale((navigator.language||'en').slice(0,2)).setCallback(onPicked).build().setVisible(true);
Notes:
- LIST mode is recommended with drive.file because thumbnails are not granted.
- setOrigin is only needed if TwinSpin runs inside an iframe; the default is the top page's origin. Origin is https://ranama.github.io; the /twinspin path does not matter.
- Other builder options: setSelectableMimeTypes (builder-level), hideTitleBar, setSize, and NAV_HIDDEN when only one view is used.
- Picking a folder does NOT grant its contents under drive.file. Users must multi-select the files inside a folder.

Callback:
function onPicked(d){ if (d[P.Response.ACTION] !== P.Action.PICKED) return; for (const doc of d[P.Response.DOCUMENTS]) queue(doc); }
DocumentObject fields used: id, name, mimeType, sizeBytes (absent for items uploaded in the session), lastEditedUtc (ms), resourceKey ('' if none), parentId, url.
- Skip mimeType 'application/vnd.google-apps.shortcut'. Shortcut resolution under drive.file is undocumented; the target is likely not granted.
- Skip 'application/vnd.google-apps.*' (Docs files, which need files.export with a 10 MB cap; never audio).

Download (2-3 in parallel):
async function dl(doc,onProg){ const h={Authorization:'Bearer '+token}; if(doc.resourceKey) h['X-Goog-Drive-Resource-Keys']=doc.id+'/'+doc.resourceKey; const res=await fetch('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(doc.id)+'?alt=media&supportsAllDrives=true',{headers:h}); if(res.status===401) throw needReconnect; if(!res.ok){ const e=await res.json().catch(()=>({})); throw new Error(e.error?.errors?.[0]?.reason||res.status); } const total=+res.headers.get('Content-Length')||doc.sizeBytes||0; const rd=res.body.getReader(); const parts=[]; let got=0; for(;;){ const {done,value}=await rd.read(); if(done) break; parts.push(value); got+=value.length; onProg(got,total);} return new File(parts, doc.name, {type: doc.mimeType, lastModified: doc.lastEditedUtc||Date.now()}); }
Then: const [entry]=await library.add([file]); await library.update(entry.id,{source:'gdrive', driveFileId: doc.id}). Dedupe is by name+size+lastModified.

Error reasons to map:
- 404 notFound: usually a wrong or missing setAppId (it must be the project number of the same project as the client ID), or the file was not picked.
- 403 cannotDownloadFile: the owner disabled downloads; check capabilities.canDownload.
- 403 cannotDownloadAbusiveFile: needs acknowledgeAbuse=true after warning the user.
- 403 userRateLimitExceeded / 429: back off.

Range: supported (Range: bytes=a-b gives 206), so chunked or resumable downloads are possible. Content-Range is not CORS-exposed, so take the size from sizeBytes or files.get?fields=size.

Quota (new model since 2026-05-01 for new projects): 1,000,000 units/min/project; 325,000 units/min/user. files.get costs 5 units and files.download 200; Google does not say which applies to alt=media. Under 400M units/day is not billed. Egress cap 1 TB/day/project. Effectively free for this use.

Optional mobile CSS (undocumented Picker DOM class names, verify on device):
@media (max-width:600px){.picker-dialog{left:0!important;top:0!important;width:100vw!important;height:100dvh!important}.picker-dialog-content,.picker-dialog-content iframe{width:100%!important;height:100%!important}}
Keep TwinSpin overlays below the Picker's z-index.

Alternative wrapper: the Google-maintained web component @googleworkspace/drive-picker-element (latest 0.7.3; pin the version, not @latest, e.g. https://unpkg.com/@googleworkspace/drive-picker-element@0.7.3/dist/index.iife.min.js). Usage: <drive-picker client-id app-id developer-key multiselect max-items scope><drive-picker-docs-view mime-types include-folders mode parent owned-by-me></drive-picker-docs-view></drive-picker>. Events: picker-oauth-response (detail.access_token, for the downloads), picker-picked, picker-canceled, picker-error, picker-oauth-error. It still uses the same GIS popup.
- **pros**: - No backend and no secrets: the client ID, API key and project number are all public by design.
- drive.file is non-sensitive, so the app can be published to everyone with no verification, no security assessment and no 100-user cap. It is also the scope Google recommends with the Picker.
- The user sees Google's own Drive UI (folders, search, shared-with-me, shared drives) and can multi-select.
- CORS is confirmed for both deployment origins, including Authorization and Range headers.
- The per-file grant persists, so TwinSpin can re-download picked songs later (for example after IndexedDB eviction) without re-picking.
- It fits the existing Library.add(File[]) pipeline unchanged.
- Free under the 2026 quota model.
- **cons**: - About 10 Cloud Console steps for a non-developer.
- Consent screen shows the domain, not the name 'TwinSpin', unless brand-verified; that is hard on a github.io subdomain.
- Tokens last about 1 hour with no silent refresh: re-auth needs a tap and a brief popup.
- Picker UI is desktop-sized and not documented for phones; needs a device test and CSS override.
- Popup auth is risky in iOS home-screen (standalone) mode, so it needs fallback C.
- Picking a folder does not grant its files: users must multi-select the songs (setMaxItems caps the selection).
- No shortcut resolution.
- Whole-file download before playback.
- The API key in a public repo triggers GitHub's partner alert to Google (not push-blocked) and possibly Google warning emails. Mitigated by the referrer and API restrictions.
- The OAuth client is auto-deleted after 6 months unused.
- sources: https://developers.google.com/workspace/drive/picker/guides/overview https://developers.google.com/workspace/drive/picker/guides/web-picker https://developers.google.com/workspace/drive/picker/guides/web-picker-sample https://developers.google.com/workspace/drive/picker/guides/sample https://developers.google.com/workspace/drive/picker/reference/picker.pickerbuilder https://developers.google.com/workspace/drive/picker/reference/picker.pickerbuilder.setappid https://developers.google.com/workspace/drive/picker/reference/picker.docsview https://developers.google.com/workspace/drive/picker/reference/picker.documentobject https://developers.google.com/workspace/drive/picker/reference/picker.viewid https://developers.google.com/workspace/drive/picker/guides/web-component https://github.com/googleworkspace/drive-picker-element https://registry.npmjs.org/@googleworkspace/drive-picker-element/latest https://developers.google.com/identity/oauth2/web/guides/use-token-model https://developers.google.com/identity/oauth2/web/reference/js-reference https://developers.google.com/identity/oauth2/web/guides/choose-authorization-model https://developers.google.com/workspace/drive/api/guides/api-specific-auth https://developers.google.com/workspace/drive/api/guides/manage-downloads https://developers.google.com/workspace/drive/api/guides/limits https://developers.google.com/workspace/guides/configure-oauth-consent https://developers.google.com/workspace/guides/create-credentials https://docs.cloud.google.com/docs/authentication/api-keys https://support.google.com/cloud/answer/15549945 https://developers.googleblog.com/en/usability-and-safety-updates-to-google-auth-platform/ https://raw.githubusercontent.com/open-webui/open-webui/main/src/lib/utils/google-drive-picker.ts https://denieler.com/blog/google-where-is-the-drive-picker Live curl CORS test 2026-10-15/16: OPTIONS/GET https://www.googleapis.com/drive/v3/files/{id}?alt=media with Origin https://ranama.github.io and http://localhost:8100
### B. Public share link / public folder link via API key only (no sign-in)
- **howItWorks**: The user sets a Drive file or folder to 'Anyone with the link: Viewer' and pastes the link into TwinSpin. TwinSpin parses the ID from /file/d/{id}/, ?id={id} or /drive/folders/{id}, plus a resourcekey param if present. Files are downloaded with GET https://www.googleapis.com/drive/v3/files/{id}?alt=media&key=API_KEY. Folders are listed with GET https://www.googleapis.com/drive/v3/files?q='{folderId}'+in+parents+and+trashed=false&fields=nextPageToken,files(id,name,mimeType,size,modifiedTime,resourceKey)&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true&key=API_KEY, filtering for audio/*. The API key is used for anonymous access to public data.
- **userSetup**: Same Cloud project as approach A, but only steps 1-2 (enable the Google Drive API) and step 8 are required. Step 8: the API key's API restrictions must include Google Drive API, with website restrictions https://ranama.github.io/* and http://localhost:8100/*. End user: in Drive, Share > General access > 'Anyone with the link' > Viewer > Copy link, then paste it into TwinSpin.
- **browserConstraints**: CORS for key-based GET was tested live: a response for a fake key or ID still carries Access-Control-Allow-Origin: https://ranama.github.io and exposes Content-Length. A full successful public download was not tested. drive.google.com/uc?export=download and drive.usercontent.google.com/download links returned no ACAO header, so they are not usable from fetch(). The referrer restriction works because browsers send the origin as Referer cross-origin (strict-origin-when-cross-origin). Works identically on iPhone Safari, Android Chrome and iOS standalone PWA: no popups, no third-party iframe.
- **apiDetails**: Header for older link-shared files: X-Goog-Drive-Resource-Keys: {fileId}/{resourceKey} (allowed by CORS preflight). The download loop is identical to approach A, minus the Authorization header plus &key=. Errors: 403/404 when the file is not public; 403 downloadQuotaExceeded for heavily downloaded public files. Quota: list 100 units, get 5 units.
- **pros**: - No OAuth, no consent screen, no popup and no Picker UI problems on phones.
- Works in the iOS home-screen PWA.
- A whole folder can be imported in one go, which drive.file cannot do.
- Very simple code.
- **cons**: - The user's files must be public to anyone with the link, which is a privacy trade-off for personal music collections.
- Users must change sharing in Drive manually.
- Heavily shared files can hit Google's download throttling.
- The API key must allow the Drive API (still referrer-locked).
- sources: https://developers.google.com/workspace/drive/picker/guides/web-picker https://developers.google.com/workspace/drive/api/guides/manage-downloads https://developers.google.com/workspace/drive/api/guides/limits https://docs.cloud.google.com/docs/authentication/api-keys Live curl CORS test 2026-10-16: GET https://www.googleapis.com/drive/v3/files/{id}?alt=media&key=… with Origin https://ranama.github.io
### C. Redirect-based token fallback for iOS home-screen (standalone) mode
- **howItWorks**: When running standalone on iOS, where GIS popups may never return the token, navigate the whole page to https://accounts.google.com/o/oauth2/v2/auth?client_id={clientId}&redirect_uri=https://ranama.github.io/twinspin/&response_type=token&scope=https://www.googleapis.com/auth/drive.file&include_granted_scopes=true&state={random}&prompt=select_account. Google redirects back to https://ranama.github.io/twinspin/#access_token=…&expires_in=3599&state=…. TwinSpin verifies state (stored in sessionStorage), strips the fragment with history.replaceState, then opens the Picker exactly as in approach A.
- **userSetup**: In the same Web OAuth client from approach A, add Authorized redirect URIs 'https://ranama.github.io/twinspin/' and 'http://localhost:8100/'. Redirect URIs need an exact match, including the trailing slash.
- **browserConstraints**: A full-page redirect avoids popup and window.opener problems. The out-of-scope navigation to accounts.google.com is shown inside the PWA with a browser bar, and the return to an in-scope URL lands back in the app. That last point is inferred, not tested. Save any app state before navigating away, because the page reloads.
- **apiDetails**: This is Google's documented client-side 'OAuth 2.0 for JavaScript web apps' endpoint (implicit grant). The OAuth endpoint has no CORS, so it is a form or location navigation. Google's page now warns that the implicit flow is less secure and recommends the code flow, which needs a backend. The GIS token model (initTokenClient) is not deprecated: Google says it is the no-backend option, issues no refresh tokens, and has its 2026-05-26 page date. Do not try trigger_onepick=true (the desktop/mobile Picker redirect flow): it returns an authorization code that a web client cannot exchange without a client secret, and Google tells web pages to use the JS Picker instead.
- **pros**: Fixes the most likely iOS-PWA failure without a server. Reuses the same client ID and Picker.
- **cons**: - Uses the implicit grant, which Google flags as less secure; the token appears briefly in the URL fragment.
- Full page reload interrupts any playing audio.
- Untested on a real iOS 18/26 home-screen app.
- sources: https://developers.google.com/identity/protocols/oauth2/javascript-implicit-flow https://developers.google.com/identity/oauth2/web/guides/choose-authorization-model https://developers.google.com/workspace/drive/picker/guides/desktop-mobile-picker https://github.com/firebase/firebase-js-sdk/issues/77 https://community.auth0.com/t/login-to-pwa-on-ios-using-social-identity-provider/18109
### D. Existing <input type=file> via the OS picker (zero integration)
- **howItWorks**: TwinSpin's current file import already opens the platform picker. On iPhone, the iOS document picker (Files) lists Google Drive under Browse > Locations once the Google Drive app is installed and enabled; iOS downloads the selected file and hands Safari a normal File. On Android, Chrome's file chooser is the system Storage Access Framework picker, where Google Drive is a document provider. On desktop, Google Drive for desktop mounts a drive letter or folder.
- **userSetup**: Install the Google Drive app on the phone and sign in. On iPhone: Files app > Browse > ... > Edit > enable Google Drive. No Cloud Console setup.
- **browserConstraints**: Works in Safari tabs and home-screen PWAs, and in Android Chrome. Keep accept wide or omit it, so iOS does not grey out .flac or .m4a files. multiple is supported.
- **apiDetails**: None. Optionally add an in-app hint such as 'To import from Google Drive on your phone, tap Add songs > Browse > Google Drive'.
- **pros**: Zero setup, no OAuth, no API keys and no Google review. Works today on every target device and in standalone mode.
- **cons**: - Requires the Drive app on the phone.
- No stored Drive link, so no re-download or sync later.
- iOS Files integration quality varies.
- No browse-inside-TwinSpin experience.
- sources: https://workspaceupdates.googleblog.com/2017/09/use-google-drive-and-files-app-to.html https://www.howtogeek.com/399250/how-to-add-third-party-locations-to-turn-the-ios-files-app-into-finder/ https://www.techotopia.com/index.php/Accessing_Cloud_Storage_using_the_Android_Storage_Access_Framework
### E. Custom in-app Drive browser with drive.readonly (not recommended)
- **howItWorks**: Request drive.readonly with the GIS token model, list folders with files.list, and download any file, including whole folders, with a custom TwinSpin UI instead of the Picker.
- **userSetup**: Same as approach A, but adding drive.readonly under Data Access makes it a restricted scope. Publishing then requires full OAuth verification: a demo video and justification, plus an annual security assessment by a Google-empanelled assessor. Without that, the app stays in Testing (max 100 named test users, unverified warning, re-consent every 7 days) or an unverified production app with a 100-user lifetime cap.
- **browserConstraints**: Same CORS and popup behaviour as approach A. No Picker iframe, so the mobile UI is fully under TwinSpin's control.
- **apiDetails**: https://www.googleapis.com/auth/drive.readonly is Restricted. Restricted scopes are allowed only for certain app categories (backup/sync, productivity/education, reporting/security). Google recommends migrating to drive.file.
- **pros**: Best mobile UX (own responsive UI) and whole-folder import. Works with personal-only use under Testing.
- **cons**: - Verification and security-assessment burden (cost, annual renewal) for any public release.
- Scary consent screen ('see and download all your Google Drive files').
- The music-player use case may not qualify for restricted scopes.
- sources: https://developers.google.com/workspace/drive/api/guides/api-specific-auth https://support.google.com/cloud/answer/13464321 https://support.google.com/cloud/answer/15549945 https://support.google.com/cloud/answer/7454865
## Findings
- [high,critical] Drive API media downloads are CORS-enabled for both TwinSpin origins. The preflight to https://www.googleapis.com/drive/v3/files/{id}?alt=media from Origin https://ranama.github.io and from http://localhost:8100 returned 200 with Access-Control-Allow-Origin echoed, Allow-Methods including GET, and Allow-Headers 'authorization,range,x-goog-drive-resource-keys' (Max-Age 3600). GET responses expose Content-Length but not Content-Range.
- [high,critical] drive.file is classified Non-sensitive. drive.readonly, drive and drive.metadata.readonly are Restricted, which means verification plus an annual security assessment. Google recommends drive.file together with the Google Picker, which grants per-file access to files the user picks.
- [high,critical] The unverified-app screen and the 100-user cap are triggered only by sensitive or restricted scopes. A drive.file-only app can be set to 'In production' (External) without OAuth verification. In Testing status the app is limited to 100 listed test users, test users see an unverified warning, and authorizations expire 7 days after consent.
- [medium] Without brand verification, the consent screen shows only the application domain, not the app name 'TwinSpin'. Brand verification requires a homepage and privacy policy on a Search-Console-verified authorized domain. On a github.io subdomain this is reportedly unreliable (a forum case stuck for 36+ hours), so treat it as cosmetic and skip it, or move to a custom domain.
- [high,critical] The API key's website restrictions must include https://docs.google.com/* in addition to the app origins, because the Picker renders in a docs.google.com iframe. Without it the Picker fails with 'API developer key is invalid'. Google recommends restricting the key's APIs to Google Picker API (and Google Drive API).
- [high,critical] setAppId must be the numeric Cloud project NUMBER (IAM & Admin > Settings), not the project ID, from the same project as the OAuth client. It is required for drive.file: without it, picked files are not usable by the app.
- [high,critical] The GIS token model (google.accounts.oauth2.initTokenClient) is current and not deprecated (page updated 2026-05-26). It needs no backend and issues no refresh token. It is popup-only and must be triggered by a user gesture. The prompt default is 'select_account'; '' prompts only the first time. error_callback types are popup_failed_to_open, popup_closed and unknown. The token response's expires_in is in seconds and is typically 3599-3600 (about 1 hour).
- [low,critical] Google's docs make no mobile-browser support statement for the web Picker. The web Picker is the only option for a web page: the redirect-based 'trigger_onepick' Picker is for desktop and native apps and returns a code that needs a backend exchange. Picker dialog sizing is desktop-oriented (setSize minimum 566x350), and the Picker cannot run in embedded webviews or in-app browsers. Expect it to work in iPhone Safari and Android Chrome tabs, but verify on real devices.
- [medium,critical] TwinSpin's manifest sets display:standalone, which makes it an installable PWA. OAuth popup flows are known to fail to hand the result back in iOS home-screen (standalone) apps, while redirect flows work, so a redirect-based token fallback (OAuth 2.0 implicit endpoint, response_type=token, authorized redirect URI https://ranama.github.io/twinspin/) is advisable.
- [medium] Selecting a folder in the Picker under drive.file does not grant access to the files inside it. Users must select the audio files themselves (MULTISELECT_ENABLED, setMaxItems). Whole-folder import needs drive.readonly (restricted) or a public folder link plus an API key.
- [high] Picker filtering uses View.setMimeTypes or PickerBuilder.setSelectableMimeTypes with comma-separated exact MIME types. Wildcards such as 'audio/*' are undocumented, and there is no audio ViewId (ViewIds: DOCS, DOCS_IMAGES, DOCS_VIDEOS, DOCS_IMAGES_AND_VIDEOS, DOCUMENTS, DRAWINGS, FOLDERS, FORMS, PDFS, PRESENTATIONS, SPREADSHEETS). DocsView supports setIncludeFolders, setSelectFolderEnabled, setParent, setOwnedByMe, setEnableDrives, setStarred, setFileIds and setMode(LIST/GRID). LIST mode is recommended with drive.file.
- [high] Downloads: files.get?alt=media for blob files. The Range header is supported for partial downloads. Google Workspace docs need files.export, capped at 10 MB. Check capabilities.canDownload because owners can block downloads. Files flagged as abusive need acknowledgeAbuse=true. Shortcuts have mimeType application/vnd.google-apps.shortcut with shortcutDetails.targetId; Picker or drive.file access to a shortcut's target is undocumented.
- [high] Picker DocumentObject provides id, name, mimeType, sizeBytes (not for in-session uploads), lastEditedUtc, parentId and resourceKey. When resourceKey is non-empty, send X-Goog-Drive-Resource-Keys: {id}/{resourceKey}; the CORS preflight allows this header.
- [high] Authorized JavaScript origins must be bare origins: no path, query or fragment. HTTPS is required except for localhost. Register 'https://ranama.github.io' (not .../twinspin) and 'http://localhost:8100'. The Web client's secret is not used. Since 2025, OAuth clients unused for 6 months are auto-deleted (restorable for 30 days), and client secrets are masked after creation.
- [high] The current console layout puts OAuth configuration under 'Google Auth Platform' (Branding, Audience, Data Access, Clients, Verification Center). The API key is still made under APIs & Services > Credentials, and the console requires at least one API restriction when creating a key. Website restriction patterns look like https://ranama.github.io/*; ports are optional but must match if given.
- [medium] Drive API cost: free for this use. New projects since 2026-05-01 use quota units: 1,000,000 per minute per project and 325,000 per minute per user. Usage under 400M units per day is not billed, and charges for exceeding quota are only 'planned for later in 2026'. Egress cap is 1 TB per day per project.
- [high] A Google API key committed to a public GitHub repo is NOT blocked by GitHub push protection, but GitHub reports it to Google as a partner alert. Expect possible Google 'exposed key' emails; referrer and API restrictions are the mitigation, and keys for the Picker are client-side by design.
- [high] Google ships an official web component @googleworkspace/drive-picker-element (latest 0.7.3, Apache-2.0). It wraps GIS and the Picker, its default scope is drive.file, and it exposes the access token via the 'picker-oauth-response' event for the downloads. It also has attributes such as client-id, app-id, developer-key, multiselect, max-items, plus docs-view mime-types, include-folders and parent.
- [medium] Classic Drive direct-download URLs (drive.google.com/uc?export=download, drive.usercontent.google.com/download) returned no Access-Control-Allow-Origin header in tests, so they cannot be fetched by the web app. Use the googleapis.com/drive/v3 endpoint instead.
- [high] TwinSpin integration points: the service worker (D:\Claude\TwinSpin\sw.js) ignores cross-origin requests, so it will not interfere with googleapis. Library.add(File[]) at D:\Claude\TwinSpin\src\library\library.js:219 accepts constructed File objects and dedupes by name+size+lastModified. Config can live in window.TWINSPIN_CONFIG (D:\Claude\TwinSpin\config.js).
