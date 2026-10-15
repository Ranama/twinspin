// First-run coach marks (contract 6.4): "Tap a record to load a song" -> "Press PLAY" -> "Load deck B, press
// SYNC, slide the crossfader". Steps advance by themselves when the user does the thing, or with Next; Skip or
// the last step sets settings.tipsSeen. Settings can start the tips again.
//   const flow = new CoachFlow(app, coachBubble);  flow.start(false);  // every ~12 frames: flow.tick();

export class CoachFlow {
  /**
   * @param {object} app the AppUI (decks, settings, layout, page, setPage(), deckUIs, mixer, tabBtns, hbSongs, xfade)
   * @param {import('./overlays.js').Coach} coach the bubble
   */
  constructor(app, coach) {
    this.app = app;
    this.coach = coach;
    this.step = -1;
  }

  get active() {
    return this.step >= 0;
  }

  /** Start the tips (first run), or again on request (force). */
  start(force) {
    const app = this.app;
    if (!force && app.settings.get('tipsSeen')) return;
    if (!app.audioOn) return;
    this.step = 0;
    // the tips point at the records: leave the full-screen player page (and, on phones, the other pages)
    if (app.page === 'player' || (app.layout === 'pp' && app.page !== 'decks')) app.setPage('decks');
    this._show();
  }

  done() {
    this.step = -1;
    this.coach.hide();
    try {
      this.app.settings.set('tipsSeen', true);
    } catch {
      /* ignore */
    }
  }

  _show() {
    const app = this.app;
    const step = this.step;
    if (step < 0) return;
    const visible = (el) => !!el && typeof el.getClientRects === 'function' && el.getClientRects().length > 0;
    const loaded = app.decks.findIndex((d) => d && (d.track || d.loading));
    let target;
    let text;
    if (step === 0) {
      const plat = app.deckUIs[0].platWrap;
      target = visible(plat) ? plat : visible(app.tabBtns.songs) ? app.tabBtns.songs : app.hbSongs;
      text = 'Tap a record to load a song. Or open Songs to try the demo tracks.';
    } else if (step === 1) {
      const u = app.deckUIs[Math.max(0, loaded)];
      target = visible(u.btnPlay) ? u.btnPlay : null;
      text = 'Press PLAY.';
    } else {
      const u = app.deckUIs[1];
      target = visible(u.btnSync) ? u.btnSync : app.mixer.xfEl;
      text = 'Load deck B, press SYNC, then slide the crossfader from A to B.';
    }
    this.coach.show({
      target, text, step: step + 1, steps: 3, nextLabel: step === 2 ? 'Done' : 'Next',
      onNext: () => {
        this.step = step + 1;
        if (this.step > 2) this.done();
        else this._show();
      },
      onSkip: () => this.done(),
    });
  }

  /** Advance when the user did the step; otherwise keep the bubble next to its target. */
  tick() {
    if (this.step < 0 || !this.coach.visible) return;
    const app = this.app;
    // The tips teach mixing by hand. Someone who opened the music player or switched Auto Mix on is past that:
    // end them quietly instead of pointing at deck controls over the player page.
    if (app.page === 'player' || (app.automix && app.automix.enabled)) {
      this.done();
      return;
    }
    const anyLoaded = app.decks.some((d) => d && (d.track || d.loading));
    const anyPlaying = app.decks.some((d) => d && d.playing);
    if (this.step === 0 && anyLoaded) {
      this.step = 1;
      this._show();
    } else if (this.step === 1 && anyPlaying) {
      this.step = 2;
      this._show();
    } else if (this.step === 2 && app.decks[1] && app.decks[1].synced && Math.abs(app.xfade) > 0.5) {
      this.done();
    } else this.coach.place();
  }
}
