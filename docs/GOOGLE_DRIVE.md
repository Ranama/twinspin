# Google Drive in TwinSpin: one-time setup

TwinSpin can open songs from your Google Drive: **Songs > Add music > Google Drive** signs you in with Google's
own window, shows Google's file picker, and downloads the songs you pick onto your device (they then play offline
like any other song). TwinSpin has no server of its own, so Google needs to know about the app once: a free
**Google Cloud project** that gives three public values for `config.js`.

This takes about 15 minutes, is free (no billing account, no credit card) and is done once by whoever runs this
copy of TwinSpin. Everybody who uses the app afterwards just taps Google Drive.

> **No setup at all?** Your phone's own file picker already reaches Google Drive: install the Google Drive app,
> then **Add music > This device** and pick **Google Drive** in the picker (iPhone: Browse > Drive; Android:
> the picker's menu > Drive). See [Without any setup](#without-any-setup) below.

What TwinSpin asks Google for: only the **`drive.file`** permission, "see and download the files you open with this
app". TwinSpin cannot see the rest of your Drive. This permission needs no Google review, so the app can be
published for everyone.

---

## What you need

* A Google account (a normal Gmail account works).
* A computer with a browser (the Cloud Console is hard to use on a phone).
* The address of your TwinSpin. For the official copy that is **https://ranama.github.io/twinspin/**. If you run
  your own copy at another address, replace `https://ranama.github.io` everywhere below with your own address
  (origin only: `https://` + host, no path).

## Step 1. Create the project

1. Open **https://console.cloud.google.com** and sign in with the Google account that will own the app.
2. In the top bar, click the **project selector** (next to "Google Cloud") > **New project**.
3. **Project name:** `TwinSpin`. Location: leave it as it is. Click **Create**.
4. When it is ready, make sure the project selector at the top shows **TwinSpin** (select it if not).

No billing account is needed. If Google asks for one, you are on the wrong page: nothing here costs money.

## Step 2. Turn on the two APIs

1. Menu (☰) > **APIs & Services** > **Library**.
2. Search **Google Drive API**, open it, click **Enable**.
3. Back to the Library, search **Google Picker API**, open it, click **Enable**.

## Step 3. The consent screen (what Google shows when people sign in)

1. Menu (☰) > **Google Auth Platform** (in older consoles: APIs & Services > OAuth consent screen).
2. If it says "Google Auth Platform not configured yet", click **Get started**:
   * **App information:** App name `TwinSpin`; User support email: your email. **Next**.
   * **Audience:** choose **External**. **Next**.
   * **Contact information:** your email. **Next**.
   * Tick **I agree to the Google API Services: User Data Policy**. **Continue** > **Create**.
3. **Google Auth Platform > Branding:**
   * **App home page:** `https://ranama.github.io/twinspin/`
   * **Application privacy policy link:** `https://ranama.github.io/twinspin/privacy.html`
   * **Authorized domains:** click **Add domain** and type `ranama.github.io`.
   * **Do not upload a logo.** A logo makes Google require a brand review; without it nothing needs review.
   * Click **Save**.
4. **Google Auth Platform > Data Access:** **Add or remove scopes** > in the filter type `drive.file` > tick
   **`.../auth/drive.file`** ("See, edit, create and delete only the specific Google Drive files you use with this
   app") > **Update** > **Save**.
   (This must match what the app asks for. If it is missing, Google shows an "unverified app" warning.)
5. **Google Auth Platform > Audience:** click **Publish app** > **Confirm**. The publishing status becomes
   **In production**.
   * With only `drive.file`, Google does not need to verify the app: there is no warning screen, no 100-user limit
     and sign-ins do not expire after 7 days.
   * (If you prefer to stay in **Testing** for now: add your Gmail under **Test users**. In Testing, only listed
     test users can sign in, they see an "unverified app" warning, and their sign-in expires after 7 days.)

The sign-in window shows the domain `ranama.github.io` rather than the name "TwinSpin". That is normal for apps
without a brand review and does not limit anything.

## Step 4. The sign-in client (Client ID)

1. **Google Auth Platform > Clients** > **Create client**.
2. **Application type:** **Web application**. **Name:** `TwinSpin web`.
3. **Authorized JavaScript origins** > **Add URI** for each of these (exactly like this: no path, no slash at the
   end):
   * `https://ranama.github.io`
   * `http://localhost:8100` (for trying TwinSpin on your own computer with `tools\serve.ps1`)
   * `http://localhost` (Google recommends both localhost forms for local testing)
4. **Authorized redirect URIs:** leave empty. TwinSpin never uses a redirect (it would stop the music).
5. If you see **Use this client for an AI-powered agent**, leave it **unticked** (it cannot be changed later).
6. Click **Create**. Copy the **Client ID** (it ends in `.apps.googleusercontent.com`). The client secret is not
   used: ignore it, never share it.

New origins can take from 5 minutes to a few hours before Google accepts them.

## Step 5. The API key

1. Menu (☰) > **APIs & Services** > **Credentials** > **Create credentials** > **API key**.
2. The console asks for at least one API restriction: choose **Google Picker API** and **Google Drive API**.
3. Open the new key (click its name) to finish the restrictions:
   * **Application restrictions:** **Websites**, then **Add** each of these:
     * `https://ranama.github.io/*`
     * `http://localhost:8100/*`
     * `https://docs.google.com/*` (required: Google's file picker runs on docs.google.com; without it the
       picker says "API developer key is invalid")
   * **API restrictions:** **Restrict key** with **Google Picker API** and **Google Drive API** ticked.
   * **Save**.
4. Copy the key (it starts with `AIza`).

## Step 6. The project NUMBER

1. Menu (☰) > **IAM & Admin** > **Settings** (or the **Project info** card on the console's dashboard).
2. Copy the **Project number**: 12 digits. **Not** the project ID (which looks like `twinspin-123456`).

It has to be the number of the same project as the Client ID, otherwise picked files cannot be opened.

## Step 7. Send the three values

Send these three values to whoever maintains TwinSpin (or put them in `config.js` yourself):

| Value | Looks like | Where it came from |
|---|---|---|
| Client ID | `123456789012-abc...xyz.apps.googleusercontent.com` | Step 4 |
| API key | `AIzaSy...` | Step 5 |
| Project number | `123456789012` | Step 6 |

All three are **public by design**: they are visible to anyone who opens the website, and they only work from the
addresses you registered. They are not passwords.

For the developer, in `config.js`:

```js
window.TWINSPIN_CONFIG = window.TWINSPIN_CONFIG || {
  google: {
    clientId: '123456789012-abc...xyz.apps.googleusercontent.com',
    apiKey: 'AIzaSy...',
    appId: '123456789012',          // the project NUMBER
  },
};
```

Then publish the site again (the GitHub Action, or `tools\publish-web.ps1 -Repo ...`; see `docs/DEPLOY.md`).
GitHub or Google may warn you by email that an API key was found in the repository: that is expected for this kind
of key (it is public by design), and the website and API restrictions from step 5 are what protect it.

## Step 8. Try it

1. Open **https://ranama.github.io/twinspin/** (on a phone: in Safari or Chrome itself, not inside another app).
   After an update, tap **Reload** in the "Update ready" message.
2. **Songs > Add music > Google Drive**.
3. Choose your Google account and allow TwinSpin "to see the files you open with this app".
4. In Google's picker, tap the songs you want (tap several to pick many, up to 60: the number of songs TwinSpin
   keeps on a device), then **Select**.
5. TwinSpin shows "Importing from Google Drive" with the progress and a Cancel button. The songs then appear in
   your songs (with a small cloud) and at the end of the set list.

Good to know:

* Picking a **folder** does not give access to the songs inside it: open the folder and pick the songs.
* To import a whole folder at once, share it in Drive with **Anyone with the link** and use **Add music > Paste a
  Google Drive link** (no sign-in; only songs directly inside the folder; anyone with that link can open those
  files).
* Google's sign-in lasts about an hour. After that, tapping Google Drive asks again (one tap).
* **Settings > Google Drive > Sign out** forgets the sign-in on this device. To remove TwinSpin's access
  completely: your Google Account > Security > Third-party apps & services > TwinSpin > Remove access.

## If something goes wrong

| What you see | What to do |
|---|---|
| "Google Drive isn't set up in this copy of TwinSpin yet" | The three values are not in `config.js` yet (step 7), or the site was not published again. |
| A Google page with **Error 400: origin_mismatch** or **redirect_uri_mismatch** | The address is missing under Authorized JavaScript origins (step 4). Add it exactly (`https://ranama.github.io`, no path) and wait up to a few hours. |
| The picker says **"API developer key is invalid"** or **"The API developer key is invalid"** | Step 5: add `https://docs.google.com/*` to the key's websites, and make sure the Google Picker API is enabled (step 2) and allowed on the key. |
| **"Google hasn't verified this app"** | Step 3.4: add `drive.file` under Data Access, and step 3.5: Publish app. (In Testing mode, only test users can sign in.) |
| Picked songs fail with "not found" | The project number (step 6) is wrong or from another project. Use the 12-digit number of the same project as the Client ID. |
| "Allow pop-ups for TwinSpin" | The browser blocked Google's sign-in window. Allow pop-ups for the site, then tap Google Drive again. |
| Nothing happens inside Instagram, Facebook or another app's browser | Google blocks sign-in inside other apps. Open TwinSpin in Safari or Chrome. |
| On an iPhone Home Screen app the sign-in window does not come back | Open TwinSpin in Safari and try there, or use **Add music > This device > Browse > Drive** (works everywhere). Songs you add in Safari stay in Safari's copy of TwinSpin. |
| Testing on a phone through `tools\phone-link.cmd` | That link changes every time, so Google cannot know it. Test Google Drive on the published site instead. |

**Maintenance:** Google deletes sign-in clients that nobody used for 6 months (they can be restored for 30 days in
the console). Keep the project's contact email up to date.

## Without any setup

The phone's own file picker can open Google Drive files; TwinSpin just receives the file:

* **iPhone / iPad:** install the **Google Drive** app and sign in. In the **Files** app: Browse > ⋯ > Edit >
  switch on **Drive**. Then in TwinSpin: **Add music > This device > Browse > Drive**, pick the songs.
* **Android:** **Add music > This device**, open the picker's menu (☰) and choose **Drive**.
* **Computer:** with **Google Drive for desktop**, your Drive is a folder or drive letter: **Add music > This
  device** and pick from it.

Songs added this way are copies; they do not remember that they came from Drive.
