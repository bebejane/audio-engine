// Tiny static file server for the browser stress page (ES modules + import
// maps need http://, not file://). Serves tests/browser/ on :8123.
//
//   node tests/browser/serve.mjs [port]
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || 8123);

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.wasm': 'application/wasm',
	'.map': 'application/json; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.wav': 'audio/wav',
};

createServer((req, res) => {
	const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
	const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
	const file = normalize(join(root, rel));
	if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
		res.writeHead(404, { 'content-type': 'text/plain' });
		res.end('not found: ' + rel);
		return;
	}
	res.writeHead(200, {
		'content-type': MIME[extname(file)] || 'application/octet-stream',
		'cache-control': 'no-store',
	});
	createReadStream(file).pipe(res);
}).listen(port, () => {
	console.log(`stress page: http://localhost:${port}/`);
});
