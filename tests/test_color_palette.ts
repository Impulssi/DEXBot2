/**
 * Visual color palette comparison — shows every changed color side by side.
 * Run: npx node dist/tests/test_color_palette.js
 */

const O = '\x1b[0m';

const old: Record<string, string> = {
  green:    '\x1b[32m',       // buy / active / ON
  yellow:   '\x1b[33m',       // spread / warn
  blue:     '\x1b[34m',       // partial
  cyan:     '\x1b[36m',       // debug / headers
  white:    '\x1b[37m',       // info / menu text
  red:      '\x1b[31m',       // sell / error / alerts / sellDark
  redBright: '\x1b[91m',      // not used originally
  greenDark: '\x1b[38;5;22m', // buyDark
  boldGreen: '\x1b[1;32m',    // unlock OK
  boldRed:   '\x1b[1;31m',    // unlock WARN
  gray:      '\x1b[38;5;246m',
};

const neu: Record<string, string> = {
  green:    '\x1b[92m',
  yellow:   '\x1b[93m',
  blue:     '\x1b[94m',
  cyan:     '\x1b[38;5;87m',
  white:    '\x1b[97m',
  redDark:  '\x1b[38;5;160m',
  redBright: '\x1b[91m',
  greenDark: '\x1b[38;5;28m',
  boldGreen: '\x1b[1;92m',
  boldRed:   '\x1b[1;31m',
  gray:      '\x1b[38;5;246m',
};

type Row = { label: string; role: string; oldCode: string; newCode: string };

const rows: Row[] = [
  { label: 'buy / active / ON',  role: 'green',    oldCode: old.green,    newCode: neu.green    },
  { label: 'sell / error /alert', role: 'redBright', oldCode: old.red, newCode: neu.redBright },
  { label: 'sellDark (distr.)', role: 'redDark',   oldCode: old.red,  newCode: neu.redDark  },
  { label: 'spread / warn',      role: 'yellow',   oldCode: old.yellow,   newCode: neu.yellow   },
  { label: 'partial',            role: 'blue',     oldCode: old.blue,     newCode: neu.blue     },
  { label: 'debug / headers',    role: 'cyan',     oldCode: old.cyan,     newCode: neu.cyan     },
  { label: 'info / menu text',   role: 'white',    oldCode: old.white,    newCode: neu.white    },
  { label: 'buyDark',            role: 'greenDark', oldCode: old.greenDark, newCode: neu.greenDark },
  { label: 'bold green (ok)',    role: 'boldGreen', oldCode: old.boldGreen, newCode: neu.boldGreen },
  { label: 'bold red (warn)',    role: 'boldRed',  oldCode: old.boldRed,  newCode: neu.boldRed  },
];

function visible(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}
function vpadEnd(s: string, len: number): string {
  const pad = Math.max(0, len - visible(s).length);
  return s + ' '.repeat(pad);
}

const LABEL_W = 22;
const SWATCH_W = 6;

console.log(`\n${neu.cyan}Color Palette — Before  →  After${O}\n`);
console.log(`  ${vpadEnd('Role', LABEL_W)}  ${vpadEnd('Old', SWATCH_W)}  ${vpadEnd('New', SWATCH_W)}`);
console.log(`  ${'─'.repeat(LABEL_W)}  ${'─'.repeat(SWATCH_W)}  ${'─'.repeat(SWATCH_W)}`);

for (const r of rows) {
  const oldSample = `${r.oldCode}████${O}`;
  const newSample = `${r.newCode}████${O}`;
  const line = `  ${vpadEnd(r.label, LABEL_W)}  ${vpadEnd(oldSample, SWATCH_W)}  ${vpadEnd(newSample, SWATCH_W)}`;
  console.log(line);
}

console.log(`\n${neu.cyan}Grid weight colors (formatWeightLine)${O}\n`);

const buyerWeight = `${neu.green}0.55${O} (${neu.gray}0.50${O}) ${neu.green}buy${O}`;
const sellerWeight = `${neu.redBright}0.65${O} (${neu.gray}0.50${O}) ${neu.redBright}sell${O}`;
const equalWeight = `${neu.gray}0.50${O} (${neu.gray}0.50${O}) ${neu.gray}buy  ${neu.gray}0.50${O} (${neu.gray}0.50${O}) ${neu.gray}sell${O}`;
const staleAlert = `${neu.gray}0.50 (0.50) buy  ${neu.gray}0.50 (0.50) sell${O}  ${neu.redBright}(adapter offline)${O}`;

console.log(`  Higher sell → ${buyerWeight}  ${sellerWeight}`);
console.log(`  Equal       → ${equalWeight}`);
console.log(`  Stale       → ${staleAlert}`);

console.log(`\n${neu.cyan}Distribution bars (createDistributionBar)${O}\n`);
const bar = `${old.greenDark}██${O}${neu.green}███${O}${neu.redBright}████${O}${neu.redDark}██${O}`;
console.log(`  ${bar}`);
console.log(`  ${neu.gray}← buyDark / buy  sell / sellDark →${O}`);

console.log(`\n${neu.cyan}Headers (Order Analysis, === separators)${O}\n`);
const oldHeader = `${old.cyan}🔍  Order Analysis${O}`;
const newHeader = `${neu.cyan}🔍  Order Analysis${O}`;
const oldSep = `${old.cyan}${'='.repeat(50)}${O}`;
const newSep = `${neu.cyan}${'='.repeat(50)}${O}`;
console.log(`  Old:  ${oldHeader}`);
console.log(`        ${oldSep}`);
console.log(`  New:  ${newHeader}`);
console.log(`        ${newSep}`);

console.log(`\n${neu.cyan}Unlock status display${O}\n`);
const oldUnlock = `${old.boldGreen}OK${O}  ${old.white}muted text${O}  ${old.boldRed}WARN${O}`;
const newUnlock = `${neu.boldGreen}OK${O}  ${neu.white}muted text${O}  ${neu.boldRed}WARN${O}`;
console.log(`  Old:  ${oldUnlock}`);
console.log(`  New:  ${newUnlock}`);

console.log(`\n${O}`);
