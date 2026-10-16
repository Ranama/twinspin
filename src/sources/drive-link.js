// Google Drive share links: which file or folder a pasted link points at (pure; used by gdrive.js and the UI).
//   parseDriveUrl('https://drive.google.com/file/d/<id>/view?usp=sharing')  -> { kind: 'file', id }
//   parseDriveUrl('drive.google.com/drive/folders/<id>?resourcekey=0-x')   -> { kind: 'folder', id, resourceKey }

const ID_RE = /^[A-Za-z0-9_-]{10,}$/;

function parseQuery(qs) {
  const out = {};
  for (const part of String(qs || '').replace(/^\?/, '').split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const k = i < 0 ? part : part.slice(0, i);
    const v = i < 0 ? '' : part.slice(i + 1);
    try {
      out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' '));
    } catch {
      out[k] = v;
    }
  }
  return out;
}

/**
 * The file or folder a Google Drive link points at, or null when it is not a Drive file / folder link.
 * Knows /file/d/<id>/view, /file/u/0/d/<id>, open?id=, uc?id=, /drive/folders/<id>, /drive/u/1/folders/<id>,
 * /drive/mobile/folders/<id>, folderview?id=, drive.usercontent.google.com/download?id= (with or without
 * https://); `resourceKey` comes along when the link has one (older shared files need it).
 * @param {string} url
 * @returns {{ kind: 'file'|'folder', id: string, resourceKey?: string }|null}
 */
export function parseDriveUrl(url) {
  let s = String(url == null ? '' : url).trim();
  if (!s || /\s/.test(s)) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  const m = /^https?:\/\/([^/?#]+)([^?#]*)(\?[^#]*)?/i.exec(s);
  if (!m) return null;
  const host = m[1].toLowerCase().replace(/:\d+$/, '');
  if (host !== 'drive.google.com' && host !== 'docs.google.com' && host !== 'drive.usercontent.google.com') return null;
  const path = m[2] || '';
  const q = parseQuery(m[3] || '');
  let kind = null;
  let id = null;
  let r = /\/folders\/([A-Za-z0-9_-]+)/.exec(path);
  if (r) {
    kind = 'folder';
    id = r[1];
  } else if ((r = /\/file\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)/.exec(path))) {
    kind = 'file';
    id = r[1];
  } else if (q.id && /^\/(?:drive\/(?:u\/\d+\/)?)?(?:open|uc|download|folderview|embeddedfolderview|file)?\/?$/i.test(path)) {
    kind = /folderview/i.test(path) ? 'folder' : 'file';
    id = q.id;
  }
  if (!kind || !ID_RE.test(id || '')) return null;
  const out = { kind, id };
  const rk = q.resourcekey || q.resourceKey;
  if (rk && /^[A-Za-z0-9_-]{1,100}$/.test(rk)) out.resourceKey = rk;
  return out;
}

