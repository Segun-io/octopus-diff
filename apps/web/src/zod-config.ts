import { z } from 'zod';

/**
 * The daemon's CSP is `script-src 'self' 'wasm-unsafe-eval'`. zod v4 probes `Function('')` once,
 * when the first object schema is built, to decide whether it may JIT-compile parsers; the
 * probe is caught, but the browser still reports a `script-src` violation. The contracts build
 * their schemas at module-evaluation time, so this must run before `@octopus-diff/contracts`
 * evaluates: `App.tsx` imports this module first (side-effect import, kept in place by Biome).
 */
z.config({ jitless: true });
