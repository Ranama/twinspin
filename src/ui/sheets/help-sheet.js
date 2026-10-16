// Help sheet: a plain-language guide to TwinSpin (quick start, decks, records, CUE vs headphones, SYNC, mixer,
// Auto Mix and the set list, the music player, music from Google Drive or a NAS, FX and loops, outputs for this
// kind of device, keyboard shortcuts, troubleshooting). Static content.
//   host.push(helpSheet(app));

import { h, icon, setKids } from '../dom.js';
import { env } from '../../core/env.js';
import { GUIDES } from '../sources-text.js';

const KEYS = [
  ['Q', 'Play / pause deck A'], ['W', 'Cue deck A (hold to preview)'], ['E', 'Sync deck A'],
  ['P', 'Play / pause deck B'], ['O', 'Cue deck B (hold to preview)'], ['I', 'Sync deck B'],
  ['← →', 'Move the crossfader (Shift = small steps)'],
  ['1 2 3 4', 'Deck A loop: 1, 2, 4, 8 beats'], ['7 8 9 0', 'Deck B loop: 1, 2, 4, 8 beats'],
  ['M', 'Auto Mix on / off'],
  ['Space', 'Player: play / pause (while the player is open)'],
  ['N', 'Player: next song'],
  ['B', 'Player: previous song (or the start of this one)'],
  ['Esc', 'Close a panel'],
];

export function helpSheet(app) {
  const hasPlayer = !!(app && app.player);
  return {
    id: 'help',
    title: 'Help',
    mount(body) {
      const topic = (title, ico, ...paras) => h('section.help-sec', {},
        h('h3.help-h', {}, icon(ico, 'help-ico'), h('span', { text: title })),
        ...paras.map((p) => (typeof p === 'string' ? h('p', { text: p }) : p)));
      const list = (items) => h('ul.help-list', {}, items.map((t) => h('li', { text: t })));

      const phone = env.mobile;
      const outputs = phone
        ? [
          'A phone can play to only one output at a time. That is a limit of Android and iPhone, not of TwinSpin, so a Bluetooth speaker plus Bluetooth headphones is not possible.',
          list([
            'One output: everything plays from the phone or the speaker it is connected to. The headphone buttons only light the meters.',
            'Split cable: a stereo-to-dual-mono Y splitter on the headphone socket (or a USB-C adapter). One side goes to the speaker, the other to your headphones. Turn off Mono audio and Dolby or spatial sound on the phone.',
            'Second device: a second phone or a laptop plays your headphone mix over Wi-Fi. Open Outputs, choose Second device and scan the code with the other device. It runs about half a second late, so let SYNC do the beat-matching.',
          ]),
        ]
        : [
          'On a computer TwinSpin can send the main mix to one output and your headphone mix to another.',
          list([
            'Open Outputs and choose Speaker + headphones. Tap Show my speakers once (most browsers ask for the microphone only to show device names; nothing is recorded).',
            'Pick the speaker and the headphones, then use Test to hear which is which.',
            'If one sounds later than the other (Bluetooth is slow), move Output alignment until the beats line up.',
            'No second output? Split cable and Second device work here too.',
          ]),
        ];

      const keys = hasPlayer ? KEYS : KEYS.filter(([k]) => !['Space', 'N', 'B'].includes(k));
      const kbd = h('table.help-keys', {}, h('tbody', {}, keys.map(([k, what]) => h('tr', {}, h('th', {}, h('kbd', { text: k })), h('td', { text: what })))));
      const where = phone
        ? 'Open PLAYER in the tab bar (in landscape: the PLAYER button over the waveforms).'
        : 'Open PLAYER at the top (on a tablet: in the tab bar; on a phone in landscape: the button over the waveforms).';

      setKids(body,
        topic('Quick start', 'play',
          list([
            'Tap a record (or open Songs and tap Add music) and pick a song for deck A.',
            'Press PLAY. Turn it up with the deck A volume on the MIX page.',
            'Load a second song on deck B and press SYNC on deck B: it matches deck A’s tempo and beat.',
            'Press PLAY on B, then slide the crossfader from A to B. That is a mix.',
          ]),
          h('p.help-tip', { text: 'No songs at hand? Open Songs and load the two demo tracks.' }),
          h('p.help-tip', { text: 'Want TwinSpin to mix for you? Put songs in the set list and switch on Auto Mix (see below).' })),
        topic('The decks', 'decks',
          'Deck A is blue and on the left; deck B is orange and on the right. The bar at the top shows each song, its BPM (beats per minute) and the time left. Tap it for more options: BPM ×2 or ½, tap tempo, tempo range, eject.',
          list([
            'PLAY starts and pauses.',
            'CUE marks a starting point. While paused, press CUE to set the point where you are. While playing, CUE jumps back to it and stops. Hold CUE on the point to preview it; let go to jump back.',
            'The tempo field speeds the song up or down: drag it sideways, double-tap to reset. Hold − or + to push the beat slightly behind or ahead.',
          ])),
        topic('The records', 'decks',
          'Touch a record and move your finger round to scratch, like vinyl. Let go and it plays on. Turn off Scratch on the record in Settings to make the record nudge the tempo instead.',
          'The coloured ring shows how far into the song you are. It flashes red in the last 30 seconds.'),
        topic('Waveforms', 'mix',
          'Deck A’s waveform runs above deck B’s. The ticks are beats; when two playing songs are in sync, the ticks meet in the middle. Pinch to zoom. While a deck is paused, drag its waveform to find a spot. The thin strip shows the whole song: tap to jump (hold while the deck is on air, to avoid accidents).'),
        topic('CUE and the headphone buttons', 'headphones',
          'CUE is a starting point in the song. The headphone button (on the MIX page) is different: it sends that deck to your headphones so you can listen before the crowd hears it. It needs a second output; see Outputs below.'),
        topic('SYNC', 'sync',
          'SYNC matches this deck’s tempo and beat to the other deck and keeps following it. Tap again to turn it off. Hold SYNC to reset the tempo to the song’s own speed. It needs a BPM on both decks; if a BPM is wrong, tap the deck bar and use ×2, ½ or TAP.'),
        topic('Mixer', 'mix',
          list([
            'Volume faders set each deck’s level; MASTER sets the overall level.',
            'HI, MID and LOW: drag up for more, down for less. All the way down removes that part (KILL).',
            'FILTER: left makes the sound muffled (low-pass), right makes it thin (high-pass). The centre is off.',
            'The crossfader blends from deck A (left) to deck B (right). Double-tap to centre it. With the Cut curve (Settings) it jumps to your finger, for scratch cuts.',
          ])),
        topic('Auto Mix', 'auto',
          'Auto Mix plays your set list by itself, like a DJ: it matches the beats of the next song, blends it in, swaps the bass half way and then lets the new song ease back to its own tempo.',
          list([
            'Build a set list on the Songs page: tap + on any song (or Add all). Songs you add with Add music go to the end of the list too. Drag the handle to change the order.',
            'Switch on AUTO MIX (on the Songs page, in the tab bar, or press M). The countdown shows when the next mix starts; MIX NOW starts it at the next bar.',
            'Mix length (16, 32 or 64 beats), easing back to the original tempo and the bass swap are in Settings.',
            'Touch the crossfader or a control of the deck that is being mixed and Auto Mix hands the mix over to you. Switch it on again when you want.',
          ])),
        hasPlayer ? topic('Music player', 'player',
          `The player is a simple music app on top of the set list: the set list is its queue. ${where}`,
          list([
            'Press play: the queue starts (Auto Mix switches on) and moves from song to song by itself. Pause keeps your place.',
            'Pick how songs change: DJ mix (beat-matched, like a DJ), Crossfade (a plain fade of 2 to 12 seconds) or Gapless (the next song starts right when one ends).',
            'Shuffle plays the songs up next in random order; repeat goes off, all (the queue starts again) or one (this song again).',
            'Up next: drag the handle to change the order, x removes a song, tap a song to play it now. History lists what played.',
            'On the Songs page, + adds a song to the end of the queue; ⋯ has Play now and Play next.',
            'On the DECKS page the strip shows what comes next, with previous, play / pause and next. Tap it to open the player.',
          ])) : null,
        topic('Your music from Google Drive or your NAS', 'cloud',
          'Tap Add music (on the Songs page or the player) to see every way in.',
          list([
            'Google Drive: tap Google Drive, sign in with Google and pick songs (tap several to pick many). They are saved on this device, so they play offline. TwinSpin only sees the songs you pick.',
            'A Drive link: share a song or a folder with “Anyone with the link”, copy the link and use Paste a Google Drive link. No sign-in.',
            'Drive links you import are remembered on this device (Add music > Paste a Google Drive link > Saved links), so you can import one again with a tap; clearing the browser’s site data removes them.',
            'Music server / NAS: run Navidrome on your Synology NAS (or any Subsonic server), then connect with its https:// address. Browse artists, albums and playlists; songs download when they play. Save offline keeps a copy for mixing without waiting.',
            'No setup at all: your phone’s own file picker reaches Google Drive and your NAS (iPhone: the Files app; Android: the picker’s menu). See Other ways in Add music.',
            'Songs from Drive show a small cloud, songs from your server a small server sign.',
          ]),
          h('p.help-tip', {}, h('span', { text: 'Step-by-step guides: ' }),
            h('a.src-link', { href: GUIDES.drive, target: '_blank', rel: 'noopener', text: 'Google Drive' }), h('span', { text: ' · ' }),
            h('a.src-link', { href: GUIDES.nas, target: '_blank', rel: 'noopener', text: 'Synology NAS' }), h('span', { text: ' · ' }),
            h('a.src-link', { href: GUIDES.privacy, target: '_blank', rel: 'noopener', text: 'Privacy' }))),
        topic('Effects and loops', 'fx',
          list([
            'Tap an effect pad to switch it on, tap again to switch it off. Hold a pad to use it only while you hold.',
            'AMOUNT sets how strong the effects are.',
            'LOOP 1, 2, 4 or 8 repeats that many beats. Tap the same size again to let the song continue.',
            'ECHO OUT fades the deck into an echo and stops it. BRAKE stops it like a turntable switched off.',
          ])),
        topic(phone ? 'Headphones on a phone' : 'Speaker and headphones', 'outputs', ...outputs),
        env.mobile ? null : topic('Keyboard', 'help', kbd, h('p', { text: 'Drop audio files on a deck to load them.' })),
        topic('If something goes wrong', 'alert',
          list([
            'No sound? Check the volume and the MASTER fader. On iPhone, the ring/silent switch does not matter.',
            'Sound stopped after a call or the lock screen? Tap Resume, or Restart audio in Settings.',
            env.ios ? 'Songs gone after a while? Safari clears data of sites you have not used for a week. Add TwinSpin to your Home Screen to keep them.'
              : 'A file will not load? Try MP3 or WAV; some formats only play in some browsers.',
            'Big files use a lot of memory on phones; songs under 15 minutes work best.',
          ])),
      );
    },
  };
}
