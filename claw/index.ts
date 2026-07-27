

import * as bitsharesClient from './modules/bitshares_client';
import * as chainActions from './modules/chain_actions';
import * as chainBroadcast from './modules/chain_broadcast';
import * as chainQueries from './modules/chain_queries';
import * as clawBridge from './modules/claw_bridge';
import * as clawCatalog from './modules/claw_catalog';
import * as clawInfra from './modules/claw_infra';
import * as clawManifest from './modules/claw_manifest';
import * as clawRuntimeMatrix from './modules/claw_runtime_matrix';
import * as clawSkillMd from './modules/claw_skill_md';
import * as creditRuntimeAdapter from './modules/credit_runtime_adapter';
import * as decisionLoop from './modules/decision_loop';
import * as dexbotBridge from './modules/dexbot_bridge';
import * as dexbotCredentialClient from './modules/dexbot_credential_client';
import * as dexbotProfiles from './modules/dexbot_profiles';
import * as feedPriceSource from './modules/feed_price_source';
import * as honestEcosystem from './modules/honest_ecosystem';
import * as kibanaPriceSource from './modules/kibana_price_source';
import * as liquidityPools from './modules/liquidity_pools';
import * as memuBridge from './modules/memu_bridge';
import * as positionDiscovery from './modules/position_discovery';
import * as positionHealth from './modules/position_health';
import * as positionManager from './modules/position_manager';
import * as positionManagerWatch from './modules/position_manager_watch';
import * as shortMpaStrategy from './modules/short_mpa_strategy';
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
module.exports = _default;

