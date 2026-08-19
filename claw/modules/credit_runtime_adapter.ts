
import { PATHS } from '../../modules/paths.js';
import CreditRuntime from '../../modules/credit_runtime.js';
import { getErrorMessage } from '../../modules/utils/errors.js';
'use strict';


function createCreditRuntimeAdapter(infra: any, options: Record<string, any> = {}) {
  const _runtimes = new Map<string, any>();
  // Mirror the bot-side credit runtime state dir (PATHS.CREDIT_RUNTIME_DIR),
  // so claw status/maintenance/watchdog see the same persisted state. The old
  // `profileRoot/profiles/credit_runtime` join double-counted the profiles
  // segment and ignored the resolver.
  const _stateDir: string = options.stateDir || PATHS.CREDIT_RUNTIME_DIR;

  function _buildBotShim(botEntry: Record<string, any>): any {
    return {
      config: {
        botKey: botEntry.botKey,
        botIndex: botEntry.botIndex,
        name: botEntry.name,
        preferredAccount: botEntry.preferredAccount || options.accountName,
        debtPolicy: botEntry.debtPolicy,
        assetA: botEntry.assetA,
        assetB: botEntry.assetB,
      },
      _log: (msg: string, level?: string) => {
        const logger = infra.runtime?.logger || console;
        if (typeof logger.info === 'function') logger.info(`[credit-runtime] ${msg}`);
        else logger.log(`[credit-runtime] ${msg}`);
      },
      _warn: (msg: string) => {
        const logger = infra.runtime?.logger || console;
        if (typeof logger.warn === 'function') logger.warn(`[credit-runtime] ${msg}`);
        else console.warn(`[credit-runtime] ${msg}`);
      },
    };
  }

  // Config fingerprint so debtPolicy / asset / account edits are picked up
  // instead of being masked by a permanently cached runtime instance.
  function _botFingerprint(botEntry: Record<string, any>): string {
    return JSON.stringify({
      assetA: botEntry.assetA,
      assetB: botEntry.assetB,
      botKey: botEntry.botKey,
      debtPolicy: botEntry.debtPolicy,
      name: botEntry.name,
      preferredAccount: botEntry.preferredAccount,
    });
  }

  async function _resolveBotEntry(botRef: string | null): Promise<Record<string, any> | null> {
    if (!botRef) return null;
    try {
      const bundle = await infra.profiles.loadBundle();
      const match = bundle.bots.find(
        (b: Record<string, any>) => b.botKey === botRef || b.name === botRef,
      );
      return match || null;
    } catch {
      return null;
    }
  }

  async function _getRuntime(botRef: string | null): Promise<any> {
    if (!botRef) return null;
    const cacheKey = botRef;
    const botEntry = await _resolveBotEntry(botRef);
    if (!botEntry) return null;
    if (!botEntry.debtPolicy) {
      // Config now has no debtPolicy; drop any stale cached runtime.
      _runtimes.delete(cacheKey);
      return null;
    }

    const fingerprint = _botFingerprint(botEntry);
    const cached = _runtimes.get(cacheKey);
    if (cached && cached._fingerprint === fingerprint) return cached;

    const botShim = _buildBotShim(botEntry);
    const runtime = new CreditRuntime(botShim, { stateDir: _stateDir });
    await runtime.loadState();
    (runtime as any)._fingerprint = fingerprint;
    _runtimes.set(cacheKey, runtime);
    return runtime;
  }

  function _ensureSigningKey(rt: any, privateKey?: string): void {
    if (privateKey && !rt.bot.privateKey) {
      rt.bot.privateKey = privateKey;
    }
    if (!rt.bot.privateKey) {
      throw new Error('Missing signing key for credit runtime broadcast; provide privateKey in the call');
    }
  }

  return {
    async getStatus(botRef: string): Promise<any> {
      const rt = await _getRuntime(botRef);
      if (!rt) {
        try {
          const bundle = await infra.profiles.loadBundle();
          const bot = bundle.bots.find(
            (b: Record<string, any>) => b.botKey === botRef || b.name === botRef,
          );
          if (!bot) return { error: `bot not found: ${botRef}` };
          if (!bot.debtPolicy) return { error: `bot ${botRef} has no debtPolicy configured` };
          return { error: `unable to initialize credit runtime for ${botRef}` };
        } catch (err: any) {
          return { error: getErrorMessage(err) };
        }
      }
      await rt.refreshState();
      return rt.getStateSnapshot();
    },

    async refresh(botRef: string): Promise<any> {
      const rt = await _getRuntime(botRef);
      if (!rt) return { error: `credit runtime not available for ${botRef}` };
      await rt.refreshState();
      return rt.getStateSnapshot();
    },

    async runMaintenance(botRef: string, context = 'periodic', maintenanceOptions: Record<string, any> = {}, privateKey?: string): Promise<any> {
      const rt = await _getRuntime(botRef);
      if (!rt) return { skipped: true, reason: `credit runtime not available for ${botRef}` };
      _ensureSigningKey(rt, privateKey);
      return rt.runMaintenance(context, maintenanceOptions);
    },

    async runWatchdog(botRef: string, privateKey?: string): Promise<any> {
      const rt = await _getRuntime(botRef);
      if (!rt) return { skipped: true, reason: `credit runtime not available for ${botRef}` };
      _ensureSigningKey(rt, privateKey);
      return rt.runCreditWatchdog();
    },

    async processReborrows(botRef: string, privateKey?: string): Promise<any> {
      const rt = await _getRuntime(botRef);
      if (!rt) return { processed: 0, remaining: 0 };
      _ensureSigningKey(rt, privateKey);
      return rt.processPendingReborrows();
    },

    listRuntimes(): any[] {
      return Array.from(_runtimes.entries())
        .filter(([_, rt]) => rt.isEnabled())
        .map(([key, rt]) => ({
          botKey: key,
          enabled: rt.isEnabled(),
        }));
    },

    getRuntime(botRef: string): any | null {
      return _runtimes.get(botRef) || null;
    },
  };
}

export { createCreditRuntimeAdapter }

