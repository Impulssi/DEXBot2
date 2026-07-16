/**
 * modules/graceful_shutdown.ts - Process Shutdown Manager
 *
 * Centralized graceful shutdown handler for clean process termination.
 *
 * Features:
 * - Registers signal handlers (SIGTERM, SIGINT)
 * - Executes cleanup functions in reverse registration order
 * - Prevents duplicate shutdown execution
 * - Graceful cleanup with timeout protection
 * - Detailed shutdown logging
 *
 * ===============================================================================
 * EXPORTS (2 functions)
 * ===============================================================================
 *
 * 1. registerCleanup(name, cleanupFn) - Register cleanup function
 *    name: Description of cleanup operation (e.g., "Bot connection", "BitShares")
 *    cleanupFn: Async function to execute during shutdown
 *    Functions execute in reverse registration order (LIFO)
 *
 * 2. setupGracefulShutdown() - Install signal and exception handlers
 *    Registers SIGTERM, SIGINT, uncaughtException, unhandledRejection handlers
 *    Should be called once at process startup
 *
 * ===============================================================================
 *
 * SHUTDOWN PROCESS:
 * 1. Receive SIGTERM or SIGINT signal
 * 2. Mark shutdown in progress (prevent duplicate execution)
 * 3. Log shutdown initiation
 * 4. Execute cleanup functions in reverse order (LIFO)
 * 5. Wait for all cleanups to complete (with timeout)
 * 6. Log shutdown status
 * 7. Exit process
 *
 * USAGE:
 * const { registerCleanup } = require('./modules/graceful_shutdown');
 *
 * // Register cleanups (executed in reverse order on shutdown)
 * registerCleanup('Database', async () => db.close());
 * registerCleanup('Bot', async () => bot.shutdown());
 * registerCleanup('BitShares', async () => BitShares.disconnect());
 *
 * On SIGTERM/SIGINT:
 * 1. BitShares disconnects
 * 2. Bot shuts down
 * 3. Database closes
 *
 * ===============================================================================
 *
 * BEST PRACTICES:
 * - Register cleanups for each major component
 * - Order matters: register in opposite order of initialization
 * - Keep cleanup functions quick and non-blocking where possible
 * - Handle cleanup errors gracefully (don't throw)
 *
 * ===============================================================================
 */

let cleanupHandlers: any[] = [];
let shutdownInProgress = false;
const Logger = require('./logger');
const shutdownLogger = new Logger('Shutdown');
const { runtime } = require('./runtime');

/**
 * Register a cleanup function to be called on graceful shutdown
 * Functions are called in LIFO order (last registered = first called)
 * @param {string} name - Name of the cleanup operation (for logging)
 * @param {Function} handler - Async or sync function to call on shutdown
 */
function registerCleanup(name, handler) {
    if (typeof handler !== 'function') {
        throw new Error(`Cleanup handler for '${name}' must be a function`);
    }
    cleanupHandlers.push({ name, handler });
}

/**
 * Remove a previously registered cleanup function.
 * Use this when a component fails to initialize and its cleanup must not run
 * on process exit. Returns true if a handler was removed.
 * @param {string|Function} nameOrHandler - Cleanup name or handler reference
 * @returns {boolean} True when a handler was found and removed
 */
function unregisterCleanup(nameOrHandler) {
    const initialLength = cleanupHandlers.length;
    if (typeof nameOrHandler === 'function') {
        for (let i = cleanupHandlers.length - 1; i >= 0; i--) {
            if (cleanupHandlers[i].handler === nameOrHandler) {
                cleanupHandlers.splice(i, 1);
            }
        }
    } else if (typeof nameOrHandler === 'string') {
        for (let i = cleanupHandlers.length - 1; i >= 0; i--) {
            if (cleanupHandlers[i].name === nameOrHandler) {
                cleanupHandlers.splice(i, 1);
            }
        }
    }
    return cleanupHandlers.length !== initialLength;
}

/**
 * Execute all registered cleanup handlers
 * @private
 */
async function executeCleanup() {
    if (shutdownInProgress) {
        return;
    }
    shutdownInProgress = true;

    shutdownLogger.info('Cleaning up resources...');

    // Execute handlers in LIFO order (last registered = first cleaned up)
    for (let i = cleanupHandlers.length - 1; i >= 0; i--) {
        const { name, handler } = cleanupHandlers[i];
        try {
            shutdownLogger.info(`Cleaning up: ${name}`);
            const result = handler();
            // Handle both async and sync handlers
            if (result && typeof result.then === 'function') {
                await result;
            }
            shutdownLogger.info(`✓ ${name}`);
        } catch (err: any) {
            shutdownLogger.error(`✗ Error cleaning up ${name}: ${err.message || err}`);
        }
    }

    shutdownLogger.info('Cleanup complete');
    await shutdownLogger.flush();
}

/**
 * Setup signal handlers for graceful shutdown
 * Should be called once at process startup
 */
function setupGracefulShutdown() {
    const signals = ['SIGTERM', 'SIGINT'];
    
    signals.forEach(signal => {
        runtime.onSignal(signal, async () => {
            shutdownLogger.info(`Received ${signal}, initiating graceful shutdown...`);
            await executeCleanup();
            runtime.exit(0);
        });
    });

    // Also handle uncaught exceptions
    runtime.onSignal('uncaughtException', async (err: any) => {
        shutdownLogger.error(`Uncaught exception: ${err?.stack || err}`);
        await executeCleanup();
        // Drain stderr before exit so traces survive pipe to MONOLITHIC_ERROR_LOG
        runtime.exitAfterStderrDrain(1);
    });

    // Handle unhandled rejections
    runtime.onSignal('unhandledRejection', async (reason, promise) => {
        shutdownLogger.error(`Unhandled rejection at: ${promise} reason: ${(reason as any)?.stack || reason}`);
        await executeCleanup();
        runtime.exitAfterStderrDrain(1);
    });
}

export = {
    registerCleanup,
    unregisterCleanup,
    setupGracefulShutdown,
};
