// Registers the TypeScript loader hook (see ./ts-hook.mjs). Load this with
// `node --import ./tests/register-ts.mjs <script>`.
import { register } from 'node:module';

register(new URL('./ts-hook.mjs', import.meta.url));
