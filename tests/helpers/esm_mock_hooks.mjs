import { register } from 'node:module';

const manifestPath = process.env.DEXBOT_ESM_MOCK_MANIFEST;
register(new URL('./esm_mock_loader.mjs', import.meta.url), import.meta.url, {
    data: { manifestPath },
});
