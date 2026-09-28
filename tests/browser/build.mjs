// Bundles the engine's TypeScript sources into browser-loadable ES modules for
// the stress page. This is a TEST-ONLY tool: it transpiles every `src/**/*.ts`
// with the installed TypeScript compiler and rewrites bundler-style relative
// specifiers to real `.js` paths. Bare npm imports (events, jszip, moment,
// webmidi, …) are left as-is and resolved by the import map in index.html to
// the tiny shims in ./shims — so nothing new is added to the package itself.
//
//   node tests/browser/build.mjs
//
// Output: tests/browser/build/ (gitignored).

import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const srcDir = join(root, 'src');
const outDir = join(here, 'build');

const TRANSPILE = {
	module: ts.ModuleKind.ESNext,
	target: ts.ScriptTarget.ES2022,
	importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
	verbatimModuleSyntax: false,
};

function walk(dir, out = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, entry.name);
		if (entry.isDirectory()) walk(p, out);
		else out.push(p);
	}
	return out;
}

/** Map a relative specifier to a browser-loadable one (adds .js / /index.js). */
function resolveRelative(fromFile, spec) {
	const base = resolve(dirname(fromFile), spec);
	const candidates = [
		[base + '.ts', '.js'],
		[join(base, 'index.ts'), '/index.js'],
		[base + '.js', '.js'],
		[base + '.mjs', '.mjs'],
	];
	for (const [file, ext] of candidates) {
		if (existsSync(file)) return spec + ext;
	}
	return null;
}

function rewriteSpecifiers(fromFile, code) {
	// from './x'  /  import('./x')  /  new URL('./x', import.meta.url)
	const sub = (_m, pre, spec, post) => {
		const mapped = resolveRelative(fromFile, spec);
		return pre + (mapped ?? spec) + post;
	};
	code = code.replace(/(\bfrom\s*['"])(\.[^'"]+)(['"])/g, sub);
	code = code.replace(/(\bimport\(\s*['"])(\.[^'"]+)(['"]\s*\))/g, sub);
	code = code.replace(
		/(new\s+URL\(\s*['"])(\.[^'"]+)(['"]\s*,\s*import\.meta\.url\s*\))/g,
		sub,
	);
	return code;
}

rmSync(outDir, { recursive: true, force: true });
let count = 0;

for (const file of walk(srcDir)) {
	const rel = relative(srcDir, file);
	const outPath = join(outDir, rel);
	mkdirSync(dirname(outPath), { recursive: true });

	if (file.endsWith('.ts')) {
		const source = readFileSync(file, 'utf8');
		const { outputText } = ts.transpileModule(source, { compilerOptions: TRANSPILE });
		writeFileSync(outPath.replace(/\.ts$/, '.js'), rewriteSpecifiers(file, outputText));
		count++;
	} else {
		// vendored assets (e.g. signalsmith-stretch.mjs) are copied verbatim
		copyFileSync(file, outPath);
	}
}

console.log(`built ${count} modules -> ${relative(root, outDir)}`);
