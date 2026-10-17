declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<object, object, unknown>;
  export default component;
}

declare module '*.svg' {
  const url: string;
  export default url;
}

interface ImportMetaEnv {
  // '1': demo data in the browser, no sign-in and no API (npm run dev:mock, src/mock), in development only (src/mock/enabled.ts);
  // a build refuses it (vite.config.ts).
  readonly VITE_MOCK?: string;
  // With VITE_MOCK: the demo organization's scenario, as src/mock/scenario.ts reads it ("acme,workloads=60").
  readonly VITE_MOCK_SCENARIO?: string;
}
