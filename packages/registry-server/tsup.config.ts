import { defineConfig } from 'tsup';

export default defineConfig({
  esbuildPlugins: [
    {
      name: 'preserve-node-sqlite',
      setup(build) {
        build.onResolve({ filter: /^node:/ }, (args) => {
          return { path: args.path, external: true };
        });
      },
    },
  ],
});
