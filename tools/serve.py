#!/usr/bin/env python3
"""Static server for Carsim, with caching disabled.

python -m http.server lets the browser cache ES modules, so an edit to a file
under src/ can silently not take effect on reload -- you end up debugging code
that isn't running. Everything here is served no-store.

    python3 tools/serve.py [port]
"""

import http.server
import socketserver
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Quiet: one line per request drowns the console during a test run.
        pass


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", port), NoCacheHandler) as httpd:
        print(f"carsim serving on http://localhost:{port}  (game: /  tests: /test.html)")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
