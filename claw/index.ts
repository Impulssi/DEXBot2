

import * as bitsharesClient from './modules/bitshares_client.js';
import * as chainActions from './modules/chain_actions.js';
import * as chainBroadcast from './modules/chain_broadcast.js';
import * as chainQueries from './modules/chain_queries.js';
import * as clawBridge from './modules/claw_bridge.js';
import * as clawCatalog from './modules/claw_catalog.js';
import * as clawInfra from './modules/claw_infra.js';
import * as clawManifest from './modules/claw_manifest.js';
import * as clawRuntimeMatrix from './modules/claw_runtime_matrix.js';
import * as clawSkillMd from './modules/claw_skill_md.js';
import * as creditRuntimeAdapter from './modules/credit_runtime_adapter.js';
import * as decisionLoop from './modules/decision_loop.js';
import * as dexbotBridge from './modules/dexbot_bridge.js';
import * as dexbotCredentialClient from './modules/dexbot_credential_client.js';
import * as dexbotProfiles from './modules/dexbot_profiles.js';
import * as feedPriceSource from './modules/feed_price_source.js';
import * as honestEcosystem from './modules/honest_ecosystem.js';
import * as kibanaPriceSource from './modules/kibana_price_source.js';
import * as liquidityPools from './modules/liquidity_pools.js';
import * as memuBridge from './modules/memu_bridge.js';
import * as positionDiscovery from './modules/position_discovery.js';
import * as positionHealth from './modules/position_health.js';
import * as positionManager from './modules/position_manager.js';
import * as positionManagerWatch from './modules/position_manager_watch.js';
import * as shortMpaStrategy from './modules/short_mpa_strategy.js';
const _default = {
  ...bitsharesClient,
  ...chainActions,
  ...chainBroadcast,
  ...chainQueries,
  ...clawBridge,
  ...clawCatalog,
  ...clawInfra,
  ...clawManifest,
  ...clawRuntimeMatrix,
  ...clawSkillMd,
  ...creditRuntimeAdapter,
  ...decisionLoop,
  ...dexbotBridge,
  ...dexbotCredentialClient,
  ...dexbotProfiles,
  ...feedPriceSource,
  ...honestEcosystem,
  ...kibanaPriceSource,
  ...liquidityPools,
  ...memuBridge,
  ...positionDiscovery,
  ...positionHealth,
  ...positionManager,
  ...positionManagerWatch,
  ...shortMpaStrategy,

  // Disambiguate root exports that would otherwise be overwritten by spread order.
  describeClawBridge: clawManifest.describeClawBridge,
  describeMemuBridge: memuBridge.describeMemuBridge,
  resolveAccountName: chainQueries.resolveAccountName,
  resolveSigningAccountName: chainBroadcast.resolveAccountName
};
export default _default;
// CJS compatibility - tsx/require gets the object directly


