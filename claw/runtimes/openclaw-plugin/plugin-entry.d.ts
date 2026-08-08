declare module 'openclaw/plugin-sdk/plugin-entry' {
  export interface OpenclawPluginConfig {
    id: string;
    name: string;
    description?: string;
    register(api: any): void;
  }
  const definePluginEntry: (config: OpenclawPluginConfig) => any;
  export default definePluginEntry;
}
