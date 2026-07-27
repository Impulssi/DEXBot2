const { createClawInfrastructure } = require('../modules/claw_infra');
const { getErrorMessage } = require('../../modules/utils/errors');

async function main() {
  const profileRoot = process.argv[2] || process.env.DEXBOT_PROFILE_ROOT || null;
  const botRef = process.argv[3] || null;

  const claw = createClawInfrastructure({
    profileRoot,
    runtime: {
      name: 'claw-profiles',
      profileRoot
    }
  });

  const context = await claw.profiles.getClawProfileContext(botRef);

  console.log(JSON.stringify({
    profileRoot: context.profileRoot,
    runtime: context.runtime,
    selectedBot: context.selectedBot,
    selectedBotFiles: context.selectedBotFiles,
    selectedBotState: {
      hasAmaProfile: Boolean(context.selectedBotState && context.selectedBotState.selectedAmaProfile),
      orderSnapshotLoaded: Boolean(context.selectedBotState && context.selectedBotState.orderSnapshot),
      gridPriceSnapshotLoaded: Boolean(context.selectedBotState && context.selectedBotState.gridPriceSnapshot),
      triggerExists: Boolean(context.selectedBotState && context.selectedBotState.triggerExists)
    },
    summary: context.summary,
    settings: {
      activeBotCount: context.settings && context.settings.bots ? context.settings.bots.filter((bot) => bot.active !== false).length : 0,
      generalSettingsKeys: context.settings && context.settings.general ? Object.keys(context.settings.general) : []
    }
  }, null, 2));
}

main().catch((err) => {
  console.error(getErrorMessage(err));
  process.exit(1);
});
export {};
