/* Runs the real game code (bots, poop field, physics) on the SERVER inside a sandbox,
 * with a fake browser around it. It connects to the relay in-process and acts as the
 * permanent "host" so the world keeps running whether or not any player is online. */
const fs = require('fs');
const vm = require('vm');

// anything-goes stand-in for DOM elements / canvas contexts
function stub() {
  const fn = function () {};
  const p = new Proxy(fn, {
    get(_, k) {
      if (k === Symbol.toPrimitive) return () => '';
      if (k === 'value' || k === 'innerHTML' || k === 'textContent' || k === 'src') return '';
      if (k === 'length') return 0;
      if (k === 'then') return undefined;
      if (k === 'width' || k === 'height') return 1000;
      if (k === 'querySelectorAll') return () => [];
      if (k === 'complete') return false;
      if (k === 'getBoundingClientRect') return () => ({ left: 0, top: 0, width: 1000, height: 1000 });
      return p;
    },
    set() { return true; },
    apply() { return p; },
    construct() { return p; },
  });
  return p;
}

exports.start = function (htmlPath, onConnection) {
  let html;
  try { html = fs.readFileSync(htmlPath, 'utf8'); } catch (e) { console.log('  [world] cannot read ' + htmlPath); return; }
  html = html.replace(/data:[a-z\/+.\-]+;base64,[A-Za-z0-9+\/=]+/g, '');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);

  const handlers = {}; let clientWS = null;
  class FakeWS {                                   // browser WebSocket <-> relay, no network
    constructor() {
      clientWS = this; this.readyState = 0;
      const serverSide = {
        readyState: 1, isAlive: true,
        on: (ev, fn) => { handlers[ev] = fn; },
        send: (str) => setImmediate(() => this.onmessage && this.onmessage({ data: str })),
        ping: () => setImmediate(() => handlers.pong && handlers.pong()),
        close: () => {}, terminate: () => {},
      };
      setImmediate(() => { this.readyState = 1; onConnection(serverSide, { internal: true }); this.onopen && this.onopen(); });
    }
    send(str) { setImmediate(() => handlers.message && handlers.message(str)); }
    close() {}
  }

  const noop = () => {};
  const sb = {
    console: { log: noop, warn: noop, info: noop, debug: noop, error: (...a) => console.log('  [world]', ...a) },
    performance, setTimeout, clearTimeout, setInterval, clearInterval, Math, JSON, Date,
    requestAnimationFrame: noop, cancelAnimationFrame: noop,
    document: stub(), navigator: { userAgent: 'server', maxTouchPoints: 0 }, localStorage: { getItem: () => null, setItem: noop },
    location: { protocol: 'http:', host: 'localhost', hostname: 'localhost' },
    innerWidth: 1000, innerHeight: 1000, devicePixelRatio: 1,
    addEventListener: noop, removeEventListener: noop, matchMedia: () => stub(),
    Image: class { set src(v) {} get complete() { return false; } get naturalWidth() { return 0; } },
    Audio: class { play() { return Promise.resolve(); } pause() {} load() {} addEventListener() {} set src(v) {} },
    AudioContext: class {}, WebSocket: FakeWS, Path2D: class {},
  };
  sb.window = sb; sb.self = sb; sb.globalThis = sb;
  const ctx = vm.createContext(sb);

  try {
    for (const code of scripts) vm.runInContext(code, ctx, { filename: 'game.js' });
  } catch (e) { console.log('  [world] failed to load game code:', e && e.stack || e); return; }

  // wait for the relay link, then build the world and run it forever
  let tries = 0;
  const boot = setInterval(() => {
    if (!vm.runInContext('NET.connected && NET.myId != null', ctx)) { if (++tries > 100) clearInterval(boot); return; }
    clearInterval(boot);
    try {
      vm.runInContext(`
        mode = 'headless';
        initWorld();                                   // builds the world (and a throw-away player)
        entities = entities.filter(e => e !== player); // the server is not a player
        player.alive = false;
      `, ctx);
    } catch (e) { console.log('  [world] init failed:', e && e.stack || e); return; }

    let last = performance.now(), errs = 0;
    setInterval(() => {
      const now = performance.now(), dt = Math.min(0.05, (now - last) / 1000); last = now;
      try { ctx.update(dt); } catch (e) { if (errs++ < 5) console.log('  [world] tick error:', e && e.stack || e); }
    }, 33);
    console.log('  [world] bots + food simulation running on the server');
  }, 50);
};
