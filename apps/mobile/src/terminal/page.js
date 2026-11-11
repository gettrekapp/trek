// Runs inside the session screen's WebView (6a): xterm.js at the pty's own size, fed by the app.
// No network and no navigation (the page's CSP and the WebView's rules); the app talks to it with
// window.__trek(message) and it answers through ReactNativeWebView.postMessage.
/* global Terminal */
;(function () {
  var post = function (m) {
    window.ReactNativeWebView.postMessage(JSON.stringify(m))
  }
  var term = new Terminal({
    fontFamily: 'Menlo, monospace',
    fontSize: 11,
    scrollback: 5000,
    allowProposedApi: false,
    // OSC 8 hyperlinks in the output are never opened: activating one does nothing (the page has
    // no network and the WebView refuses any navigation anyway). No web-links addon is loaded,
    // so plain URLs aren't links at all.
    linkHandler: { activate: function () {}, allowNonHttpProtocols: false },
    theme: { background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc' }
  })
  term.open(document.getElementById('t'))
  term.onData(function (data) {
    post({ type: 'input', data: data })
  })
  // The pty's size (the server's, shared with the desktop's view): the font shrinks to fit the
  // width, down to 6 px; past that the page scrolls sideways.
  var fitFont = function (cols) {
    var width = window.innerWidth - 8
    var size = Math.max(6, Math.min(13, Math.floor(width / (cols * 0.6))))
    if (term.options.fontSize !== size) term.options.fontSize = size
  }
  window.__trek = function (m) {
    if (m.type === 'data') term.write(m.data)
    else if (m.type === 'reset') term.reset()
    else if (m.type === 'size') {
      fitFont(m.cols)
      term.resize(m.cols, m.rows)
    }
  }
  post({ type: 'ready' })
})()
