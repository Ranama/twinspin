/*
 * Suno Playlist Downloader
 * ------------------------
 * Run this in the browser console while a playlist is open on suno.com
 * (URL like https://suno.com/playlist/<id>). A small panel appears where you
 * pick the formats, then click "Download".
 *
 * - Only songs created by YOUR account are downloaded; everything else is skipped.
 * - WAV is rendered by Suno on demand and needs a plan that allows WAV downloads;
 *   if Suno refuses, that format is skipped for that song and the rest continue.
 * - Your browser may ask once to "allow multiple downloads" for suno.com — allow it.
 */
(async () => {
  const API = "https://studio-api.prod.suno.com";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- auth ----------
  async function getToken() {
    try {
      if (window.Clerk?.session) return await window.Clerk.session.getToken();
    } catch (_) {}
    const m = document.cookie.match(/(?:^|;\s*)__session=([^;]+)/);
    if (m) return decodeURIComponent(m[1]);
    throw new Error("Not signed in (no session token found). Log in to suno.com and reload.");
  }

  async function api(path, opts = {}) {
    const token = await getToken(); // fresh each call — tokens are short-lived
    const res = await fetch(API + path, {
      ...opts,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(opts.headers || {}),
      },
    });
    if (!res.ok) throw new Error(`${opts.method || "GET"} ${path} → HTTP ${res.status}`);
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }

  // ---------- who am I? ----------
  // Read the user_id from a song in your own library feed.
  async function getMyUserId() {
    const attempts = [
      () => api("/api/feed/v3", { method: "POST", body: JSON.stringify({ limit: 5 }) }),
      () => api("/api/feed/v2?page=0"),
      () => api("/api/feed/?page=0"),
    ];
    for (const attempt of attempts) {
      try {
        const data = await attempt();
        const clips = Array.isArray(data) ? data : data.clips || data.results || [];
        const id = clips.find((c) => c?.user_id)?.user_id;
        if (id) return id;
      } catch (_) {}
    }
    return null;
  }

  // ---------- playlist ----------
  function getPlaylistId() {
    const m = location.pathname.match(/\/playlist\/([0-9a-f-]{36})/i);
    if (!m) throw new Error("Open a playlist first (URL should contain /playlist/<id>).");
    return m[1];
  }

  async function getPlaylist(id) {
    let page = 1, name = "playlist", clips = [], total = Infinity;
    while (clips.length < total && page < 200) {
      const data = await api(`/api/playlist/${id}/?page=${page}`);
      if (page === 1) {
        name = data.name || name;
        total = data.num_total_results ?? Infinity;
      }
      const batch = (data.playlist_clips || []).map((pc) => pc.clip || pc).filter(Boolean);
      if (!batch.length) break;
      clips.push(...batch);
      page++;
    }
    return { name, clips };
  }

  // ---------- downloading ----------
  const safe = (s) => (s || "untitled").replace(/[\\/:*?"<>|]+/g, "_").trim().slice(0, 120);

  function saveBlob(blob, filename) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  }

  async function saveUrl(url, filename) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      saveBlob(await res.blob(), filename);
    } catch (e) {
      // Fallback: let the browser handle it (filename may not be applied cross-origin)
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.target = "_blank";
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  }

  async function getWavUrl(id) {
    // Ask Suno to render, then poll until the file is ready
    try { await api(`/api/gen/${id}/convert_wav/`, { method: "POST" }); } catch (_) {}
    for (let i = 0; i < 30; i++) {
      try {
        const d = await api(`/api/gen/${id}/wav_file/`);
        const url = d.wav_file_url || d.url;
        if (url) return url;
      } catch (_) {}
      await sleep(3000);
    }
    throw new Error("WAV not available (plan may not allow WAV, or rendering timed out)");
  }

  const FORMATS = {
    mp3:   { label: "MP3 audio", default: true },
    wav:   { label: "WAV (lossless)", default: false },
    mp4:   { label: "MP4 video", default: false },
    cover: { label: "Cover image", default: false },
    lyrics:{ label: "Lyrics (.txt)", default: false },
    json:  { label: "Metadata (.json)", default: false },
  };

  async function downloadClip(clip, formats, prefix, log) {
    const base = `${prefix}${safe(clip.title)} [${clip.id.slice(0, 8)}]`;
    const lyrics = clip.metadata?.prompt || clip.lyrics || "";
    for (const f of formats) {
      try {
        if (f === "mp3") {
          await saveUrl(clip.audio_url || `https://cdn1.suno.ai/${clip.id}.mp3`, `${base}.mp3`);
        } else if (f === "wav") {
          await saveUrl(await getWavUrl(clip.id), `${base}.wav`);
        } else if (f === "mp4") {
          if (!clip.video_url) throw new Error("no video for this song");
          await saveUrl(clip.video_url, `${base}.mp4`);
        } else if (f === "cover") {
          const img = clip.image_large_url || clip.image_url;
          if (!img) throw new Error("no cover image");
          const ext = (img.match(/\.(jpe?g|png|webp)(\?|$)/i) || [, "jpeg"])[1];
          await saveUrl(img, `${base}.${ext}`);
        } else if (f === "lyrics") {
          if (!lyrics.trim()) throw new Error("no lyrics");
          saveBlob(new Blob([`${clip.title}\n\n${lyrics}`], { type: "text/plain" }), `${base}.txt`);
        } else if (f === "json") {
          saveBlob(new Blob([JSON.stringify(clip, null, 2)], { type: "application/json" }), `${base}.json`);
        }
        await sleep(400); // be gentle with the browser and the server
      } catch (e) {
        log(`   ⚠ ${f.toUpperCase()} skipped: ${e.message}`);
      }
    }
  }

  // ---------- UI ----------
  document.getElementById("suno-dl-panel")?.remove();
  const panel = document.createElement("div");
  panel.id = "suno-dl-panel";
  panel.style.cssText = `
    position:fixed;top:16px;right:16px;z-index:2147483647;width:320px;
    background:#16161a;color:#eee;font:13px/1.4 system-ui,sans-serif;
    border:1px solid #333;border-radius:12px;padding:14px;box-shadow:0 8px 30px #0008`;
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <b style="font-size:14px">Playlist downloader</b>
      <button id="sdl-x" style="background:none;border:0;color:#aaa;font-size:18px;cursor:pointer">×</button>
    </div>
    <div style="margin-bottom:6px;color:#aaa">Formats:</div>
    <div id="sdl-formats" style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:8px">
      ${Object.entries(FORMATS).map(([k, v]) =>
        `<label style="cursor:pointer"><input type="checkbox" value="${k}" ${v.default ? "checked" : ""}> ${v.label}</label>`
      ).join("")}
    </div>
    <label style="display:block;margin-bottom:10px;cursor:pointer">
      <input type="checkbox" id="sdl-num" checked> Number files in playlist order
    </label>
    <button id="sdl-go" style="width:100%;padding:8px;border:0;border-radius:8px;background:#fff;color:#000;font-weight:600;cursor:pointer">Download</button>
    <pre id="sdl-log" style="margin:10px 0 0;max-height:220px;overflow:auto;white-space:pre-wrap;font:11px/1.4 ui-monospace,monospace;color:#bbb"></pre>`;
  document.body.appendChild(panel);

  const logEl = panel.querySelector("#sdl-log");
  const log = (msg) => { logEl.textContent += msg + "\n"; logEl.scrollTop = logEl.scrollHeight; console.log("[suno-dl]", msg); };
  panel.querySelector("#sdl-x").onclick = () => panel.remove();

  panel.querySelector("#sdl-go").onclick = async (ev) => {
    const btn = ev.currentTarget;
    const formats = [...panel.querySelectorAll("#sdl-formats input:checked")].map((i) => i.value);
    if (!formats.length) return log("Pick at least one format.");
    btn.disabled = true; btn.textContent = "Working…"; logEl.textContent = "";

    try {
      const playlistId = getPlaylistId();
      log("Checking your account…");
      const myId = await getMyUserId();
      if (!myId) throw new Error("Couldn't determine your user id (do you have songs in your library?).");

      log("Loading playlist…");
      const { name, clips } = await getPlaylist(playlistId);
      const mine = clips.filter((c) => c.user_id === myId);
      log(`"${name}": ${clips.length} songs, ${mine.length} yours, ${clips.length - mine.length} skipped (not yours).`);

      const numbered = panel.querySelector("#sdl-num").checked;
      const pad = String(clips.length).length;
      let done = 0;
      for (const clip of clips) {
        const pos = clips.indexOf(clip) + 1;
        if (clip.user_id !== myId) {
          log(`↷ skip: ${clip.title || clip.id} (by @${clip.handle || "someone else"})`);
          continue;
        }
        if (clip.status && clip.status !== "complete") {
          log(`↷ skip: ${clip.title} (status: ${clip.status})`);
          continue;
        }
        done++;
        log(`↓ [${done}/${mine.length}] ${clip.title}`);
        const prefix = numbered ? `${String(pos).padStart(pad, "0")} - ` : "";
        await downloadClip(clip, formats, prefix, log);
      }
      log(`\n✓ Finished. ${done} song(s) downloaded.`);
    } catch (e) {
      log("✗ " + e.message);
    } finally {
      btn.disabled = false; btn.textContent = "Download";
    }
  };
})();
