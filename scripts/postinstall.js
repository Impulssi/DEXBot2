'use strict';
if (process.env.npm_config_global !== 'true') {
  console.log('');
  console.log('DEXBot2 installed locally. To use the `dexbot` command:');
  console.log('  npm link                    # makes `dexbot` available globally');
  console.log('  # or use: npx dexbot <cmd>  # or: ./node_modules/.bin/dexbot <cmd>');
  console.log('');
  process.exit(0);
}
console.log('');
console.log('DEXBot2 installed! To get started:');
console.log('  dexbot keys        Set up master password');
console.log('  dexbot bots        Create and manage bots');
console.log('  dexbot unlock      Run credential daemon + bot');
console.log('  dexbot help        Show all commands');
console.log('');
