// Menu sheet (the header menu button): Outputs (with the current routing), Songs, Add music, the music player,
// Settings, Help, Full screen and Install where available, the iPhone "Add to Home Screen" hint, and the version line.
//   host.open(menuSheet(app));

import { h, icon } from '../dom.js';
import { section, navRow } from './sheet.js';
import { outputsSheet } from './outputs-sheet.js';
import { settingsSheet } from './settings-sheet.js';
import { helpSheet } from './help-sheet.js';
import { addMusicSheet } from './add-music-sheet.js';
import { canInstall, promptInstall, showIosInstallHint, canFullscreen, isFullscreen, toggleFullscreen } from '../install.js';

export function menuSheet(app) {
  return {
    id: 'menu',
    title: 'Menu',
    mount(body, host) {
      const out = navRow('outputs', 'Outputs and headphones', app.describeOutputs(), () => host.push(outputsSheet(app)));
      const songs = navRow('songs', 'Songs', 'Add music, load demo tracks', () => {
        host.close();
        app.showSongs();
      });
      const set = navRow('gear', 'Settings', 'Tempo range, scratch, crossfader, screen', () => host.push(settingsSheet(app)));
      const help = navRow('help', 'Help', 'How everything works, in plain words', () => host.push(helpSheet(app)));
      const add = navRow('plus', 'Add music', 'This device, Google Drive, music server / NAS', () => host.push(addMusicSheet(app)));
      const rows = [out.el, songs.el, add.el];
      if (app.player) {
        const player = navRow('player', 'Music player', 'The queue: play, shuffle, repeat, transitions', () => {
          host.close();
          app.showPlayer();
        });
        rows.push(player.el);
      }
      rows.push(set.el, help.el);
      if (canFullscreen()) {
        const fs = navRow('fullscreen', isFullscreen() ? 'Leave full screen' : 'Full screen', 'Hide the browser bars', () => {
          toggleFullscreen();
          host.close();
        }, { noChevron: true });
        rows.push(fs.el);
      }
      if (canInstall()) {
        const inst = navRow('install', 'Install TwinSpin', 'Opens like an app, full screen, and keeps your songs', () => {
          promptInstall().then((ok) => {
            if (ok) app.toast('Installed. Open TwinSpin from your home screen.', { kind: 'ok' });
          });
          host.close();
        }, { noChevron: true });
        rows.push(inst.el);
      }
      body.append(section('', ...rows));
      if (showIosInstallHint()) {
        body.append(section('Use it like an app',
          h('p.ios-hint', {}, h('span', { text: 'Tap ' }), icon('share', 'inline-ico'),
            h('span', { text: ' Share, then “Add to Home Screen”. TwinSpin then opens full screen, and Safari keeps your songs.' }))));
      }
      const info = app.buildInfo();
      body.append(h('p.menu-foot', { text: `TwinSpin ${info.version} · ${app.describeOutputs()}` }));
    },
  };
}
