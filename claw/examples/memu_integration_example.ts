import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { createMemuBridge } = require('../modules/memu_bridge');

async function main() {
  console.log('=== memU + DEXBot2 Integration Example ===\n');

  try {
    const memu = createMemuBridge({
      memuDir: process.env.MEMU_DIR || undefined,
      llmProfiles: process.env.OPENAI_API_KEY
        ? {
            default: {
              base_url: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
              api_key: process.env.OPENAI_API_KEY,
              chat_model: process.env.OPENAI_CHAT_MODEL || 'gpt-4o',
              embed_model: process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small',
              client_backend: 'sdk'
            }
          }
        : undefined
    });

    console.log('memU bridge created');
    console.log(`  memuDir: ${memu.memuDir}`);
    console.log(`  stateDir: ${memu.stateDir}\n`);

    console.log('--- Step 1: Check memU status ---');
    const status = await memu.getStatus();
    console.log('Status:', JSON.stringify(status, null, 2));
    console.log();

    console.log('--- Step 2: Memorize a trading conversation ---');
    const conversation = [
      { role: 'user', content: 'I prefer BTS/USD grid bots with 2% increment and 70/30 sell/buy weight' },
      { role: 'assistant', content: 'I will configure the grid bot with those settings.' },
      { role: 'user', content: 'Also, I want to be notified if the price drops more than 5%' }
    ];

    const memorizeResult = await memu.memorizeConversation(conversation, { user_id: 'trader-001' });
    console.log('Memorized conversation:', JSON.stringify(memorizeResult, null, 2));
    console.log();

    console.log('--- Step 3: Memorize trading context ---');
    const tradingContext = {
      bot: 'BTS/USD-grid',
      event: 'grid_rebalanced',
      details: {
        oldIncrement: 0.015,
        newIncrement: 0.02,
        sellWeight: 0.7,
        buyWeight: 0.3,
        gridLevels: 25
      },
      timestamp: new Date().toISOString()
    };

    const contextResult = await memu.memorizeTradingContext(tradingContext, { user_id: 'trader-001' });
    console.log('Memorized trading context:', JSON.stringify(contextResult, null, 2));
    console.log();

    console.log('--- Step 4: List categories ---');
    const categories = await memu.listCategories({ user_id: 'trader-001' });
    console.log('Categories:', JSON.stringify(categories, null, 2));
    console.log();

    console.log('--- Step 5: Retrieve trading context ---');
    const retrievalResult = await memu.retrieveTradingContext(
      'What are my preferences for BTS/USD grid bots?',
      { user_id: 'trader-001' }
    );
    console.log('Retrieved context:', JSON.stringify(retrievalResult, null, 2));
    console.log();

    console.log('--- Step 6: List memory items ---');
    const items = await memu.listItems({ user_id: 'trader-001' });
    console.log('Memory items:', JSON.stringify(items, null, 2));
    console.log();

    console.log('=== Example completed successfully ===');
  } catch (error: any) {
    console.error('Error:', error.message);
    console.error('\nNote: memU requires Python 3.13+ and the memu-py package.');
    console.error('Install with: pip install memu-py');
    console.error('Set OPENAI_API_KEY for LLM operations.');
    process.exit(1);
  }
}

main();
export {};
