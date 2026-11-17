// Runs inside the session screen's WebView (6a): xterm.js fed by the app. While the screen shows
// a session the phone sizes the pty to the space this page has (it says 'fit' with that size, on
// load and whenever the WebView's size changes, the keyboard opening included); a size from
// another client (the desktop taking it back) is followed with the font fitted to the width.
// No network and no navigation (the page's CSP and the WebView's rules); the app talks to it with
// window.__trek(message) and it answers through ReactNativeWebView.postMessage.
/* global Terminal */
;(function () {
  var post = function (m) {
    window.ReactNativeWebView.postMessage(JSON.stringify(m))
  }
  // The font the phone's own size is drawn at.
  var BASE_FONT = 11
  // #t's padding, on each side.
  var PAD = 4
  var term = new Terminal({
    fontFamily: 'Menlo, monospace',
    fontSize: BASE_FONT,
    scrollback: 5000,
    allowProposedApi: false,
    // OSC 8 hyperlinks in the output are never opened: activating one does nothing (the page has
    // no network and the WebView refuses any navigation anyway). No web-links addon is loaded,
    // so plain URLs aren't links at all.
    linkHandler: { activate: function () {}, allowNonHttpProtocols: false },
    theme: { background: '#111113', foreground: '#ededf0', cursor: '#ededf0' }
  })
  term.open(document.getElementById('t'))
  term.onData(function (data) {
    post({ type: 'input', data: data })
  })
  // A cell's size at BASE_FONT: xterm's own measure (what its fit addon reads), scaled from the
  // font in use; a monospace estimate when it isn't there.
  var cell = function () {
    var scale = BASE_FONT / term.options.fontSize
    try {
      var c = term._core._renderService.dimensions.css.cell
      if (c.width > 0 && c.height > 0) return { width: c.width * scale, height: c.height * scale }
    } catch (e) {
      // Not measured yet: the estimate.
    }
    return { width: BASE_FONT * 0.6, height: Math.ceil(BASE_FONT * 1.2) }
  }
  // The size that fills the page at BASE_FONT, and the last one sent.
  var fitted = null
  var sendFit = function () {
    var c = cell()
    var cols = Math.floor((window.innerWidth - 2 * PAD) / c.width)
    var rows = Math.floor((window.innerHeight - 2 * PAD) / c.height)
    // A WebView not laid out yet (or squeezed to nothing) proposes no size.
    if (cols < 20 || rows < 4) return
    if (fitted && fitted.cols === cols && fitted.rows === rows) return
    fitted = { cols: cols, rows: rows }
    post({ type: 'fit', cols: cols, rows: rows })
  }
  var fitTimer = null
  window.addEventListener('resize', function () {
    clearTimeout(fitTimer)
    fitTimer = setTimeout(sendFit, 150)
  })
  // Touch scrolling through the scrollback: xterm doesn't scroll on touch, so a vertical swipe
  // scrolls its lines (a sideways one is left to the page, for a size wider than the screen).
  // A tap still reaches xterm, which focuses it and opens the keyboard.
  var touch = null
  var el = document.getElementById('t')
  el.addEventListener(
    'touchstart',
    function (e) {
      if (e.touches.length !== 1) return (touch = null)
      touch = { x: e.touches[0].clientX, y: e.touches[0].clientY, axis: null, rest: 0 }
    },
    { passive: true }
  )
  el.addEventListener(
    'touchmove',
    function (e) {
      if (!touch || e.touches.length !== 1) return
      var x = e.touches[0].clientX
      var y = e.touches[0].clientY
      if (!touch.axis) {
        var ax = Math.abs(x - touch.x)
        var ay = Math.abs(y - touch.y)
        if (ax < 6 && ay < 6) return
        touch.axis = ay >= ax ? 'y' : 'x'
      }
      if (touch.axis !== 'y') return
      e.preventDefault()
      var h = cell().height * (term.options.fontSize / BASE_FONT)
      var moved = touch.rest + (touch.y - y)
      var lines = moved > 0 ? Math.floor(moved / h) : Math.ceil(moved / h)
      touch.rest = moved - lines * h
      touch.y = y
      if (!lines) return
      // The normal screen scrolls its own scrollback. A full-screen app (the alternate screen,
      // which has none) gets the swipe as the mouse wheel, as on the desktop: xterm sends it a
      // wheel report when it tracks the mouse, arrow keys when not.
      if (term.buffer.active.type === 'normal') term.scrollLines(lines)
      else {
        var screen = el.querySelector('.xterm-screen') || el
        var step = lines > 0 ? 1 : -1
        for (var i = 0; i < Math.abs(lines); i++) {
          screen.dispatchEvent(new WheelEvent('wheel', { deltaY: step, deltaMode: 1, bubbles: true, cancelable: true, clientX: x, clientY: y }))
        }
      }
    },
    { passive: false }
  )
  el.addEventListener('touchend', function () {
    touch = null
  })
  // Another client's size: the font shrinks to fit the width, down to 6 px; past that the page
  // scrolls sideways.
  var fitFont = function (cols) {
    var width = window.innerWidth - 2 * PAD
    var size = Math.max(6, Math.min(13, Math.floor(width / (cols * 0.6))))
    if (term.options.fontSize !== size) term.options.fontSize = size
  }
  window.__trek = function (m) {
    if (m.type === 'data') term.write(m.data)
    else if (m.type === 'reset') term.reset()
    // A Windows server's pty (ConPTY): set before its output is written.
    else if (m.type === 'windowsPty') {
      term.options.windowsPty = { backend: 'conpty', buildNumber: m.buildNumber }
      // ConPTY clears the screen when a pty starts: keep what it clears in scrollback (a restart keeps its old output), as the desktop does.
      term.options.scrollOnEraseInDisplay = true
    }
    else if (m.type === 'size') {
      if (fitted && fitted.cols === m.cols && fitted.rows === m.rows) {
        if (term.options.fontSize !== BASE_FONT) term.options.fontSize = BASE_FONT
      } else fitFont(m.cols)
      term.resize(m.cols, m.rows)
    }
  }
  post({ type: 'ready' })
  requestAnimationFrame(sendFit)
})()
