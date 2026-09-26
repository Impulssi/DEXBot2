const assert = require('assert');
const { EventEmitter } = require('events');

const { readInput, readPassword } = require('../modules/order/utils/system');

class MockStdin extends EventEmitter {
    isTTY = true;
    isRaw = false;
    encoding = null;
    resumed = false;

    setRawMode(value) {
        this.isRaw = value;
    }

    resume() {
        this.resumed = true;
    }

    setEncoding(value) {
        this.encoding = value;
    }
}

class MockStdout {
    [key: string]: any;
    output = '';

    write(value) {
        this.output += String(value);
    }
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withMockedConsole(run) {
    const stdin = new MockStdin();
    const stdout = new MockStdout();
    const originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
    const originalStdout = Object.getOwnPropertyDescriptor(process, 'stdout');

    Object.defineProperty(process, 'stdin', { configurable: true, value: stdin });
    Object.defineProperty(process, 'stdout', { configurable: true, value: stdout });

    try {
        await run({ stdin, stdout });
    } finally {
        Object.defineProperty(process, 'stdin', originalStdin);
        Object.defineProperty(process, 'stdout', originalStdout);
    }
}

async function testPasswordMaskingDoesNotLeakInput() {
    await withMockedConsole(async ({ stdin, stdout }) => {
        const resultPromise = readPassword('Enter password: ');

        stdin.emit('data', 'secret\n');

        const result = await resultPromise;
        assert.strictEqual(result, 'secret');
        assert.ok(stdout.output.includes('******'), 'password prompt should render mask characters');
        assert.ok(!stdout.output.includes('secret'), 'password prompt must not echo raw input');
    });
}

async function testDelayedArrowSequenceEditsAtCursor() {
    await withMockedConsole(async ({ stdin }) => {
        const resultPromise = readInput('Prompt: ');

        stdin.emit('data', 'ab');
        stdin.emit('data', '\x1b');
        await delay(50);
        stdin.emit('data', '[D');
        stdin.emit('data', 'c\n');

        const result = await resultPromise;
        assert.strictEqual(result, 'acb');
    });
}

async function testTrimDefaultAndOptOut() {
    await withMockedConsole(async ({ stdin }) => {
        const resultPromise = readInput('Prompt: ');
        stdin.emit('data', '  ama3  \n');
        assert.strictEqual(await resultPromise, 'ama3', 'default trims surrounding whitespace');
    });

    await withMockedConsole(async ({ stdin }) => {
        const resultPromise = readInput('Prompt: ', { trimInput: false });
        stdin.emit('data', '  ama3  \n');
        assert.strictEqual(await resultPromise, '  ama3  ', 'trimInput:false preserves surrounding whitespace');
    });

    await withMockedConsole(async ({ stdin }) => {
        const resultPromise = readInput('Prompt: ', { trimInput: false });
        stdin.emit('data', ' \n');
        assert.strictEqual(await resultPromise, ' ', 'trimInput:false keeps a whitespace-only entry distinguishable from a bare Enter');
    });
}

async function testDeleteRemovesCharacterAtCursor() {
    await withMockedConsole(async ({ stdin }) => {
        const resultPromise = readInput('Prompt: ');

        stdin.emit('data', 'abc');
        stdin.emit('data', '\x1b[D');
        stdin.emit('data', '\x1b[3~');
        stdin.emit('data', '\n');

        const result = await resultPromise;
        assert.strictEqual(result, 'ab');
    });
}

(async () => {
    console.log('Running readInput tests');
    await testPasswordMaskingDoesNotLeakInput();
    await testDelayedArrowSequenceEditsAtCursor();
    await testDeleteRemovesCharacterAtCursor();
    await testTrimDefaultAndOptOut();
    console.log('readInput tests passed');
})();
