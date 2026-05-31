import { defineConfig } from 'tsup';
import type { Plugin } from 'esbuild';

// Stubbed packages: optional transitive deps that ship native .node addons
// (dockerode SSH transport, ws perf accelerators). Our agent never reaches
// the code paths that need them — at runtime we connect over the unix
// docker socket and run plain ws sockets. Resolving them to a Proxy that
// throws lazily gives us a clear error if a code path is added later that
// does require them.
const STUB_PACKAGES = ['ssh2', 'cpu-features', 'bufferutil', 'utf-8-validate'];

const stubNativeAddons: Plugin = {
  name: 'stub-native-addons',
  setup(build) {
    const filter = new RegExp(
      `^(${STUB_PACKAGES.map((p) => p.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&')).join('|')})(\\/.*)?$`,
    );
    build.onResolve({ filter }, (args) => ({
      path: args.path,
      namespace: 'native-stub',
    }));
    build.onLoad({ filter: /.*/, namespace: 'native-stub' }, () => ({
      // The stub returns a Proxy that yields itself for any property
      // access (so destructuring like `const { Client } = require('ssh2')`
      // succeeds at module-load time without crashing). It only throws
      // when something actually TRIES TO USE the stub — e.g. `new Client()`
      // or `algorithms.someFn()`. Our agent never reaches those paths,
      // so the stub stays dormant.
      contents:
        'function makeStub(name) {' +
        '  const handler = {' +
        '    get(_t, prop) {' +
        '      if (prop === Symbol.toPrimitive) return () => "[stub]";' +
        '      if (prop === "then") return undefined;' /* avoid promise mis-detection */ +
        '      return makeStub(name + "." + String(prop));' +
        '    },' +
        '    apply() {' +
        '      throw new Error("[gpu-agent] native addon not bundled (stubbed at build time): " + name);' +
        '    },' +
        '    construct() {' +
        '      throw new Error("[gpu-agent] native addon not bundled (stubbed at build time): " + name);' +
        '    },' +
        '  };' +
        '  return new Proxy(function() {}, handler);' +
        '}' +
        'module.exports = makeStub("native-stub");',
      loader: 'js',
    }));
  },
};

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  target: 'node20',
  platform: 'node',
  splitting: false,
  sourcemap: true,
  clean: true,
  // Inline every runtime dep into the binary so the release tarball is
  // fully self-contained — no `npm install` on the GPU host. Match all
  // packages via regex; Node built-ins (node:fs, node:net, …) stay
  // external because they don't go through the resolver tsup sees.
  noExternal: [/.*/],
  esbuildPlugins: [stubNativeAddons],
  // Same idea for any stray .node file references that slip past the
  // resolver — treat as empty modules.
  esbuildOptions(options) {
    options.loader = { ...(options.loader ?? {}), '.node': 'empty' };
  },
  banner: { js: '#!/usr/bin/env node' },
});
