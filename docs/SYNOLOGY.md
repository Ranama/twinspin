# Your music on a Synology NAS in TwinSpin

There are two ways to play the music on your Synology NAS in TwinSpin:

1. **No setup in TwinSpin (start here):** let your phone or computer open the NAS, then use **Songs > Add music >
   This device**. The songs are copied into TwinSpin and play offline. Works today, on every device.
2. **Browse your whole library inside TwinSpin:** run **Navidrome**, a free music server, on the NAS, and connect
   with **Songs > Add music > Music server / NAS**. You browse artists, albums and playlists with cover art, and
   songs download when you play them (or when you tap **Save offline**). About 30 minutes of setup, once.

Why not connect to the NAS directly? Synology's own web interface (DSM) does not allow other websites to read it
(no "CORS"), and there is no setting to change that. Navidrome does allow it, so TwinSpin talks to Navidrome.
QuickConnect, File Station share links and the WebDAV package do not work from a web app for the same reason.

---

## Part 1. No setup: the phone's file picker opens the NAS

First, on the NAS (once): **Control Panel > File Services > SMB**: tick **Enable SMB service**. Under **Advanced
Settings**, set **Minimum SMB protocol** to SMB2 and **Maximum SMB protocol** to SMB3. Make sure your user can read
the `music` shared folder (**Control Panel > Shared Folder > music > Edit > Permissions**).

### iPhone or iPad, at home (Wi-Fi)

1. Open the **Files** app > **Browse** > **⋯** (top right) > **Connect to Server**.
2. Type `smb://` and your NAS's address, for example `smb://192.168.1.20` (find it in Synology Assistant, your
   router, or DSM: Control Panel > Network > Network Interface). Tap **Connect**.
3. Choose **Registered User**, type your DSM user name and password, **Next**.
4. In TwinSpin: **Songs > Add music > This device > Browse**. Under **Shared**, tap your NAS, open the music
   folder and tap the songs (tap **Select** first to pick several). Tap **Open**.

### iPhone or iPad, away from home

Install the **Synology Drive** app (needs iOS 18 or later):

1. On the NAS: **Package Center** > install **Synology Drive Server**. Open **Synology Drive Admin Console** >
   **Team Folder**: select your `music` folder > **Enable**.
2. On the iPhone: open the Synology Drive app and sign in with your **QuickConnect ID** (DSM: Control Panel >
   External Access > QuickConnect), user name and password.
3. In the **Files** app: Browse > ⋯ > Edit > switch on **Synology Drive**.
4. In TwinSpin: **Songs > Add music > This device > Browse > Synology Drive**, open the music folder, pick songs.

### Android

**At home:** install **CIFS Documents Provider** (free, open source, Android 8 or later; from F-Droid or Google
Play):

1. Open it > **+** > Storage: **SMB**, Host: your NAS address (for example `192.168.1.20`), Folder: `music`, your
   DSM user and password > **Check connection** > **Save**.
2. In TwinSpin: **Songs > Add music > This device**, open the picker's menu (☰) and choose the CIFS share. Pick
   the songs.

**Away from home:** the **Synology Drive** app (Android 10 or later) can **sync** a NAS music folder to the
phone's storage (Sync task). Then pick the synced songs with **Add music > This device**.

### Computer

* **Windows:** File Explorer > This PC > **Map network drive** > Folder `\\<your NAS>\music` (for example
  `\\192.168.1.20\music`) > Finish, sign in with your DSM user.
* **Mac:** Finder > **Go > Connect to Server** > `smb://<your NAS>/music` > Connect.
* Then in TwinSpin: **Add music > This device** and pick songs from that drive (or drag them onto a deck).

---

## Part 2. Navidrome on the NAS: browse your library in TwinSpin

What you get: **Add music > Music server / NAS** shows your artists, albums, playlists and a search, with cover art.
Songs download when they play; **Save offline** keeps copies for a set without Wi-Fi.

What you need:

* DSM 7.2 or later, and a NAS that can run **Container Manager** (Package Center lists it for most "+" models and
  some others such as the DS223 and DS420j; if Package Center does not offer Container Manager, use Part 1).
* Your music in a shared folder, below called `/volume1/music`.
* Access to your router, to forward one port (or Tailscale, see the end).

### Step 1. A user for the music server

So the music server can only read your music, never change anything:

1. **Control Panel > User & Group > Create**: name `navidrome`, a long random password (you will not type it
   again). **Next**.
2. Groups: leave **users** only (not administrators).
3. **Assign shared folders permissions:** `music` = **Read only**, `docker` = **Read/Write** (create the `docker`
   folder first if you have none: Control Panel > Shared Folder > Create > `docker`), everything else **No access**.
4. Applications: deny everything. **Done**.
5. In **File Station**, create the folders `docker/navidrome` and `docker/navidrome/data`.

### Step 2. Find that user's number (uid)

Container Manager needs the user's numbers. Without typing commands:

1. **Control Panel > Task Scheduler > Create > Scheduled Task > User-defined script**.
2. General: Task `whoami navidrome`, User **root**, untick **Enabled** (it only runs when you click Run).
3. Task Settings > Run command:
   ```
   id navidrome > /volume1/docker/navidrome/uid.txt
   ```
4. **OK**, select the task, click **Run**, confirm.
5. In File Station open `docker/navidrome/uid.txt`: it says something like
   `uid=1027(navidrome) gid=100(users) ...`. Note the two numbers (here **1027** and **100**). You can delete the
   task and the file afterwards.

### Step 3. Install Navidrome in Container Manager

1. **Package Center** > install **Container Manager** (if it is not installed yet).
2. Open **Container Manager > Project > Create**:
   * **Project name:** `navidrome`
   * **Path:** choose `docker/navidrome`
   * **Source:** **Create docker-compose.yml**, and paste this (put your own uid and gid from step 2 on the
     `user:` line):

   ```yaml
   services:
     navidrome:
       image: deluan/navidrome:latest
       container_name: navidrome
       user: "1027:100"            # uid:gid of the navidrome user (step 2)
       ports:
         - "4533:4533"
       restart: unless-stopped
       environment:
         ND_SCANSCHEDULE: "1h"     # look for new music every hour
         ND_LOGLEVEL: "info"
       volumes:
         - /volume1/docker/navidrome/data:/data
         - /volume1/music:/music:ro   # read-only: Navidrome can never change your music
   ```

   If your music folder is somewhere else, change `/volume1/music` (File Station > the folder > Properties shows
   its full path).
3. **Next**. Skip the Web portal settings (**Next**), then **Done**. Container Manager downloads Navidrome and
   starts it; the project shows a green **Running** after a minute.

### Step 4. First start of Navidrome

1. On a computer at home, open `http://<your NAS address>:4533` (for example `http://192.168.1.20:4533`).
2. Create the **admin** account (the first account is the administrator; keep it for managing Navidrome).
3. Navidrome scans your music (Settings > Library or the activity icon shows progress; large libraries take a
   while). Albums appear as they are found.
4. Create the account TwinSpin uses: the user menu > **Users** > **+**: user name `twinspin`, a strong password,
   **Is admin** off. **Save**.

### Step 5. A web address with a certificate (DDNS + Let's Encrypt)

Phones only connect to an `https://` address with a valid certificate.

1. **Control Panel > External Access > DDNS > Add**:
   * **Service provider:** Synology
   * **Hostname:** pick a name, for example `yourname` → `yourname.synology.me`
   * Tick **Get a certificate from Let's Encrypt and set it as default**.
   * **OK**. After a minute the status says **Normal**.
2. **Control Panel > Security > Certificate**: there is now a certificate for `yourname.synology.me`. Open it
   (**Edit** or the details): it should also cover `*.yourname.synology.me` (DSM adds the wildcard for
   synology.me names). If it does not: **Add > Add a new certificate > Get a certificate from Let's Encrypt**,
   Domain name `yourname.synology.me`, Subject Alternative Name `*.yourname.synology.me`.

### Step 6. Reverse proxy: https://music.yourname.synology.me → Navidrome

1. **Control Panel > Login Portal > Advanced > Reverse Proxy > Create**:
   * **Reverse Proxy Name:** `navidrome`
   * **Source:** Protocol **HTTPS**, Hostname `music.yourname.synology.me`, Port **443**
   * **Destination:** Protocol **HTTP**, Hostname `localhost`, Port **4533**
   * **Save**. (Nothing is needed under Custom Header.)
2. **Control Panel > Security > Certificate > Settings**: for `music.yourname.synology.me` choose the
   `yourname.synology.me` certificate. **OK**.

### Step 7. Let the internet reach it (router)

In your router, forward **TCP port 443** to your NAS's address (port 443 → NAS port 443). Only 443.
Never forward 4533, 5000/5001 (DSM) or the SMB ports.

(If your router asks: the NAS should keep its address; give it a fixed address / DHCP reservation in the router.)

**Test:** on your phone, with Wi-Fi **off**, open `https://music.yourname.synology.me`. You should see the Navidrome
sign-in page with a padlock. Then try it with Wi-Fi on: if it does not open at home, your router does not support
"NAT loopback". Fix: a local DNS entry for `music.yourname.synology.me` pointing at the NAS (in the router, or
with Synology **DNS Server**), or connect TwinSpin while away from home first.

### Step 8. Connect TwinSpin

1. In TwinSpin: **Songs > Add music > Music server / NAS**.
2. **Server address:** `https://music.yourname.synology.me`
3. **User name / Password:** the `twinspin` Navidrome account (step 4).
4. **Remember on this device:** on, if you want to stay connected. TwinSpin keeps a sign-in key on this device,
   never your password. Off: you connect again next time.
5. **Connect**. Browse with **Artists / Albums / Playlists / Search**; tap a song for **Play now, Play next, Add
   to queue, Load on deck A / B, Save offline**. **Add all** puts an album or playlist in the queue.

Songs from the server show a small server sign in your songs (filled once saved offline). Without a connection they
stay listed; they play again after you connect, and songs you saved offline always play.

Chrome may ask to "look for and connect to any device on your local network" when you use TwinSpin at home:
choose **Allow** (that is how it reaches the NAS on your Wi-Fi).

### Keep it safe

* TwinSpin's Navidrome account is not an admin, and Navidrome reads the music folder read-only.
* Only port 443 is open to the internet, and only the music server behind it. Keep **DSM** and **Navidrome**
  updated (Container Manager > Project > navidrome > Action > Build, or **Image > Update**).
* Keep DSM's **Auto block** on (Control Panel > Security > Protection) and use 2-factor sign-in for DSM.

### No port forwarding: Tailscale (optional)

If you cannot or do not want to open a port: install **Tailscale** on the NAS (Package Center) and on your phone,
and sign both in to the same Tailscale account. On the NAS, run once (Task Scheduler as root, like step 2):

```
/var/packages/Tailscale/target/bin/tailscale serve --bg --https=443 http://127.0.0.1:4533
```

(HTTPS certificates must be switched on for your tailnet: Tailscale admin console > DNS > Enable HTTPS.)

Your server is then `https://<nas-name>.<your-tailnet>.ts.net` (shown in the Tailscale admin page, with a valid
certificate). Use that address in TwinSpin. The phone needs the Tailscale app switched on. In Chrome, allow "local
network" access when asked.

### If something goes wrong

| What TwinSpin says | What to check |
|---|---|
| "Can't reach your music server. Check the address..." | Open the address in the phone's browser. From outside your home use the `https://….synology.me` address (step 6), and check the router (step 7). At home, see the NAT loopback note in step 7. |
| "Wrong user name or password." | The Navidrome account (step 4), not your DSM account. |
| "...browsers block http:// addresses" | Use the `https://` address. `http://<NAS address>:4533` only works in Chrome on a computer or Android, at home. |
| "Your music server answered, but it doesn't let TwinSpin in." | The address does not point at Navidrome (check the reverse proxy destination: `localhost`, port 4533). |
| "Your NAS answered, but the music server behind it isn't running." | Start the project in Container Manager. |
| A certificate warning in the browser | Step 5 and step 6.2: the reverse proxy name must use the Let's Encrypt certificate. |
| A song does not play | Your browser cannot decode that format (some browsers cannot play FLAC or ALAC). MP3, AAC/M4A and WAV play everywhere. |

Any other Subsonic-compatible server works the same way (Gonic, Airsonic-Advanced, Ampache, LMS with its Subsonic
plug-in), on any NAS or computer, as long as it has an `https://` address and allows other sites (Navidrome does
this by itself).
