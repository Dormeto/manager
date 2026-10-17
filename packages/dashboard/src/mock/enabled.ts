// The demo mode's switch (npm run dev:mock): on only in development, with VITE_MOCK=1. vite build sets DEV false, so the
// branches behind it are left out of any build, whatever the environment says; the build also refuses VITE_MOCK
// (vite.config.ts), and the release a dashboard holding the demo (scripts/release/artifacts.mjs).
export const DEMO = import.meta.env.DEV && import.meta.env.VITE_MOCK === '1';

// The demo's module, loaded behind DEMO only. Its import stays here, behind the switch of this same module: a build folds
// the test and drops the import, so that no chunk of src/mock is even written (an import behind DEMO in another module would
// leave the chunk, unreferenced, in the build).
export const demo = (): Promise<typeof import('./index')> => (DEMO ? import('./index') : Promise.reject(new Error('the demo mode is for development only')));
