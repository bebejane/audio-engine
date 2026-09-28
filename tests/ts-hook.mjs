// ESM loader hook that lets Node import the engine's TypeScript sources:
//
//   * resolve  — retries bundler-style extensionless specifiers as `.ts` /
//                `/index.ts` (the engine uses `from './master'`), including
//                directory imports (`from './effects'`).
//   * load     — transpiles `.ts` with the installed TypeScript compiler. This
//                matters because Node's built-in type stripping can't elide a
//                type-only name from a mixed value import (e.g.
//                `import { Effect, EffectDefaults } from '../core'`), whereas
//                `ts.transpileModule` does.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const TRANSPILE_OPTS = {
	module: ts.ModuleKind.ESNext,
	target: ts.ScriptTarget.ES2022,
	importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
	verbatimModuleSyntax: false,
	sourcemap: false,
};

export async function resolve(specifier, context, nextResolve) {
	try {
		return await nextResolve(specifier, context);
	} catch (err) {
		const relative =
			specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/');
		const retryable =
			err && (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'ERR_UNSUPPORTED_DIR_IMPORT');
		if (retryable && relative) {
			for (const suffix of ['.ts', '/index.ts']) {
				try {
					return await nextResolve(specifier + suffix, context);
				} catch {
					// try the next candidate
				}
			}
		}
		throw err;
	}
}

export async function load(url, context, nextLoad) {
	if (url.startsWith('file:') && url.endsWith('.ts')) {
		const source = await readFile(fileURLToPath(url), 'utf8');
		const { outputText } = ts.transpileModule(source, { compilerOptions: TRANSPILE_OPTS });
		return { format: 'module', source: outputText, shortCircuit: true };
	}
	return nextLoad(url, context);
}
